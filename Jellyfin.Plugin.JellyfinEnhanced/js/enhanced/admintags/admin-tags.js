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
 * A section whose own editors write fields that are not declared above
 * names them in `writes: ['Field', …]` (one line).
 *
 * These declarations are the only fields the page writes: pageFields()
 * collects them, and the server's patch (Helpers/MediaTagsPageFields.cs)
 * accepts the same list, read from the same declarations, and nothing else.
 *
 * Every change writes the field into the page's working copy and saves it
 * on its own after a short pause, through POST JellyfinEnhanced/admin/configuration:
 * the server writes only the changed fields on top of the configuration it
 * holds at that moment, so other administrators' changes to other fields
 * are kept. Each field carries the value the page read before it was
 * edited; when another administrator changed that same field meanwhile the
 * server refuses it and the page asks: Keep mine or Take theirs. The preview
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
    const PREVIEW_STYLE_ID = 'je-tag-admin-preview-styles';

    /** The section modules the page loads, in order (paths under js/enhanced/admintags/). */
    const SECTION_FILES = [
        'tag-styles-editor.js',
        'custom-rules-editor.js',
        'sections/overview.js',
        'sections/layout.js',
        'sections/quality.js',
        'sections/genre.js',
        'sections/language.js',
        'sections/rating.js',
        'sections/agerating.js',
        'sections/status.js',
        'sections/people.js',
        'sections/awards.js',
        'sections/logos.js',
        'sections/custom.js',
        'sections/rules.js',
        'sections/colours.js',
        'sections/badges.js',
        'sections/server.js',
        'sections/portable.js',
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
        'QualityTagsEnabled', 'ShowResolutionTag', 'ShowSourceTag', 'ShowEditionTag', 'EditionTagOrder', 'ShowRuntimeTag', 'RuntimeTagOrder', 'ShowAspectRatioTag', 'AspectRatioTagOrder', 'ShowFrameRateTag', 'FrameRateTagOrder', 'ShowLowQualitySourceTag',
        'ShowDynamicRangeTag', 'ShowSpecialFormatTag', 'ShowVideoCodecTag', 'ShowAudioInfoTag', 'ResolutionTagOrder', 'SourceTagOrder',
        'DynamicRangeTagOrder', 'SpecialFormatTagOrder', 'VideoCodecTagOrder', 'AudioInfoTagOrder', 'GenreTagsEnabled', 'LanguageTagsEnabled',
        'RatingTagsEnabled', 'AgeRatingTagsEnabled', 'StatusTagsEnabled', 'PeopleTagsEnabled', 'TagsHideOnHover', 'QualityTagsPosition',
        'QualityAudioDisplayMode', 'QualityVideoCodecDisplayMode', 'QualityHdrDisplayMode', 'QualityMinimumResolution', 'QualityHideSdr',
        'SeriesQualityAggregation', 'GenreTagsPosition', 'LanguageTagsPosition', 'RatingTagsPosition', 'RatingTagsOnMovies', 'RatingTagsOnSeries',
        'RatingTagsOnSeasons', 'RatingTagsOnEpisodes', 'RatingTagsOnContinueWatching', 'RatingTagsOnNextUp', 'RatingTagsShowCommunity',
        'RatingTagsShowCritic', 'RatingTagsSources', 'RatingTagsMinScore', 'RatingTagsColorByScore', 'AgeRatingTagsPosition', 'StatusTagsPosition',
        'StatusTagsJustAdded', 'StatusTagsNewRelease', 'StatusTagsTrending', 'StatusTagsSchedule', 'StatusTagsMilestones', 'StatusTagsSeriesStatus', 'StatusTagsScenes',
        'StatusTagsLeaving', 'StatusTagsDirectPlay',
        'AwardsTagsEnabled', 'AwardsTagsPosition', 'LogoTagsEnabled', 'LogoTagsPosition', 'CustomTagsEnabled', 'CustomTagsPosition',
        'ShowRatingInPlayer', 'TagLayout', 'TagLabelDensity', 'TagScale', 'TagGap', 'TagEdgeSpacing', 'TagLayouts', 'TagGroupOrder', 'TagGroupCaps',
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
     * The PluginConfiguration fields the page writes: every declared field's
     * key (and an ordered field's orderKey) and each section's `writes`.
     * @returns {Set<string>}
     */
    function pageFields() {
        const out = new Set();
        for (const s of sections) {
            for (const f of s.fields || []) {
                out.add(f.key);
                if (f.orderKey) out.add(f.orderKey);
            }
            for (const key of s.writes || []) out.add(key);
        }
        return out;
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
        if (f.secret) return '';
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
                    + `<span class="je-ta-field-control"><input type="${f.secret ? 'password' : f.type}" id="${esc(f.id)}" ${data} value="${esc(value)}"${f.secret ? ' autocomplete="new-password" spellcheck="false"' : ''}${f.type === 'number' ? ` min="${f.min}" max="${f.max}" inputmode="numeric"` : ''}${f.pattern ? ` pattern="${esc(f.pattern)}"` : ''}${f.placeholder ? ` placeholder="${tx(f.placeholder)}"` : ''}${described}>${f.unit ? `<span class="je-ta-unit">${tx(f.unit)}</span>` : ''}</span></div>`;
            case 'textarea':
                return `<div class="je-ta-field je-ta-field--block" data-field-row="${esc(f.id)}"><span class="je-ta-switch-text"><label class="je-ta-switch-name" for="${esc(f.id)}" data-je-label>${tx(f.label)}</label>${f.desc ? `<span class="je-ta-switch-desc" id="${descId}">${tx(f.desc, f.descParams)}</span>` : ''}</span>`
                    + `<span class="je-ta-field-control"><textarea id="${esc(f.id)}" ${data} rows="${f.rows || 4}" spellcheck="false"${f.pattern ? ` pattern="${esc(f.pattern)}"` : ''}${f.placeholder ? ` placeholder="${tx(f.placeholder)}"` : ''}${described}>${esc(value)}</textarea></span></div>`;
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

    // ── Unsaved edits ──────────────────────────────────────────────────

    /**
     * The edits that are not on the server yet. They belong to the document,
     * not to one view: Jellyfin replaces the page element when the URL
     * changes, and an edit whose save failed must outlive that view until it
     * is retried. Every live view draws its save indicator from here.
     * They also belong to one administrator on one server: signing out,
     * signing in as someone else or switching servers drops them
     * (resetSession), and work started before that is ignored when it ends.
     */
    const store = {
        /** @type {Map<string, *>} field → the value to save */
        values: new Map(),
        /** @type {Map<string, *>} field → the value read before it was edited (what the server should still hold) */
        base: new Map(),
        /** @type {Map<string, *>} field → another administrator's value that refused this edit */
        conflicts: new Map(),
        /** @type {'saved'|'saving'|'error'|'conflict'} */
        state: 'saved',
        /** @type {string[]} the fields the last failed save carried */
        failed: [],
        /** @type {ReturnType<typeof setTimeout>|null} */
        timer: null,
        /** @type {Promise<boolean>|null} the save on its way */
        saving: null,
        /** @type {{get: () => Promise<Object>, patch: (changes: Object, expected: Object) => Promise<{values?: Object}>}|null} the newest view's host */
        host: null,
        /** @type {Set<(event: {type: string, values?: Object}) => void>} live views */
        views: new Set(),
        /** @type {string|null} the server and administrator the edits belong to */
        owner: null,
        /** Per-id intent, captured at the edit boundary and retained across responses. */
        itemEdits: new Map(),
        itemMode: null,
        itemFlight: null,
        /** bumped by resetSession: requests from before it are ignored when they answer */
        generation: 0,
    };

    /**
     * Who is signed in where: the server id and user id of the dashboard's
     * ApiClient, read as JE.session reads them.
     * @returns {string}
     */
    function identity() {
        try {
            if (typeof ApiClient === 'undefined' || !ApiClient) return '|';
            const server = (typeof ApiClient.serverId === 'function' ? ApiClient.serverId() : ApiClient.serverId) || ApiClient._serverInfo?.Id;
            const user = typeof ApiClient.getCurrentUserId === 'function' ? ApiClient.getCurrentUserId() : null;
            return `${server || ''}|${user || ''}`;
        } catch {
            return '|';
        }
    }

    /**
     * Another administrator, no one, or another server: drop the previous
     * session's edits, timer and live view. Saves still on their way are
     * ignored when they answer; nothing is sent with the new credentials.
     */
    function resetSession() {
        store.generation++;
        clearTimeout(store.timer);
        store.timer = null;
        store.saving = null;
        store.values.clear();
        store.base.clear();
        store.itemEdits.clear();
        store.itemMode = null;
        store.itemFlight = null;
        store.conflicts.clear();
        store.failed = [];
        store.host = null;
        store.owner = null;
        store.state = 'saved';
        if (active) {
            const previous = active;
            active = null;
            previous.ctx.dispose();
            previous.root.replaceChildren();
            delete previous.root.dataset.tab;
        }
        notify({ type: 'state' });
    }

    /** The edits belong to whoever is signed in now; anything else is dropped first. */
    function checkSession() {
        const now = identity();
        if (store.owner !== null && store.owner !== now) resetSession();
        store.owner = now;
    }

    /**
     * The session a request starts in, to compare with when it answers.
     * @returns {{generation: number, owner: string|null}}
     */
    function sessionMark() {
        checkSession();
        return { generation: store.generation, owner: store.owner };
    }

    /**
     * Whether work started under `mark` still belongs to the signed-in
     * session. The ApiClient identity is reconciled first, so a server switch
     * or sign-in JE.session has not reported yet resets the session here and
     * the old answer is dropped.
     * @param {{generation: number, owner: string|null}} mark - From sessionMark.
     * @returns {boolean}
     */
    function sameSession(mark) {
        checkSession();
        return mark.generation === store.generation && mark.owner === store.owner;
    }

    /** @returns {boolean} Whether an administrator is signed in now (a user id on the ApiClient). */
    function signedIn() {
        return !identity().endsWith('|');
    }

    /**
     * Tell every live view about a change of state or a completed save.
     * @param {{type: 'state'|'saved', values?: Object, theirs?: boolean}} event - theirs: another
     *   administrator's values were taken (they may have changed more than these fields).
     */
    function notify(event) {
        for (const view of Array.from(store.views)) view(event);
    }

    /** @param {'saved'|'saving'|'error'|'conflict'} state */
    function setStoreState(state) {
        store.state = state;
        notify({ type: 'state' });
    }

    /** @returns {boolean} Whether some edit is not on the server yet (queued, on its way or failed). */
    function hasPending() {
        return store.values.size > 0 || !!store.saving || !!store.timer;
    }

    /** @returns {Set<string>} The fields a reload must not replace: queued, on their way, failed or refused. */
    function protectedFields() {
        return new Set(store.values.keys());
    }

    /** @param {*} value @returns {*} A deep copy (JSON values only). */
    const copy = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
    /** @param {*} a @param {*} b @returns {boolean} Whether two JSON values are equal (null and missing alike). */
    const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

    /** Apply only the user's pending item operations to a fresh server list. @param {*} raw @returns {*} */
    function rebaseItemEdits(raw) {
        const looks = JE.core.tagLook.normalizeItemOverrides(raw);
        for (const [id, edit] of store.itemEdits) {
            if (edit.value) looks.set(id, JE.core.tagLook.normalizeItemOverrides([edit.value]).get(id));
            else looks.delete(id);
        }
        return JE.core.tagLook.itemOverridesToWire(looks);
    }

    /** Serialize the captured per-entry intent, without diffing a later server snapshot. @param {Map} edits @returns {Object} */
    function itemEditsMutation(edits) {
        return {
            Set: Array.from(edits.values()).filter(e => e.value).map(e => e.value),
            Remove: Array.from(edits).filter(([, e]) => !e.value).map(([id]) => id),
            Expected: Object.fromEntries(Array.from(edits, ([id, e]) => [id, e.expected])),
        };
    }

    /**
     * Read a definitive client rejection, including conflicts, if its body is available.
     * @param {*} err - The rejected request (a fetch Response from ApiClient.ajax).
     * @returns {Promise<Object<string, *>|null>}
     */
    async function rejectionOf(err) {
        if (!err || err.status < 400 || err.status >= 500) return null;
        try {
            const body = typeof err.json === 'function' ? await err.json() : err;
            return body && typeof body === 'object' ? body : null;
        } catch {
            return null;
        }
    }

    /**
     * Save every pending edit now: the server writes only these fields, on
     * top of the configuration it holds, and refuses (409) any whose value
     * another administrator changed since this page read it. A failed save
     * keeps its edits here (state 'error') for a retry from any view; a
     * refused one waits for Keep mine / Take theirs (state 'conflict') while
     * the other fields still save.
     * @returns {Promise<boolean>} Whether everything pending so far is saved.
     */
    function flushStore() {
        clearTimeout(store.timer);
        store.timer = null;
        checkSession();
        if (store.saving) return store.saving.then((ok) => (ok && store.values.size ? flushStore() : ok));
        // A canceled entry edit succeeds locally; other fields still share one atomic patch.
        if (store.itemMode === 'entries' && !store.conflicts.has('TagLookItemOverrides')) {
            for (const [id, edit] of store.itemEdits) {
                const delta = JE.core.tagLook.itemOverrideMutation(edit.expected ? [edit.expected] : null, edit.value ? [edit.value] : null);
                if (!edit.acknowledge && !delta.Set.length && !delta.Remove.length) store.itemEdits.delete(id);
            }
            if (!store.itemEdits.size) {
                const value = store.base.get('TagLookItemOverrides') ?? null;
                store.values.delete('TagLookItemOverrides');
                store.base.delete('TagLookItemOverrides');
                store.itemMode = null;
                notify({ type: 'saved', values: { TagLookItemOverrides: value } });
            }
        }
        const sent = new Map(Array.from(store.values).filter(([key]) => !store.conflicts.has(key)));
        if (!sent.size) {
            setStoreState(store.conflicts.size ? 'conflict' : 'saved');
            return Promise.resolve(!store.conflicts.size);
        }
        const host = store.host;
        const mark = { generation: store.generation, owner: store.owner };
        // The values are snapshotted here and stay in the store until the
        // server took them: a reload meanwhile keeps them, and an edit made
        // meanwhile is the next save's.
        const changes = Object.fromEntries(sent);
        const expected = {};
        const itemKey = 'TagLookItemOverrides';
        const itemEdits = sent.has(itemKey) && store.itemMode === 'entries' ? new Map(store.itemEdits) : null;
        for (const key of sent.keys()) if (store.base.has(key) && !sections.some(s => s.fields?.some(f => f.key === key && f.secret))) expected[key] = store.base.get(key);
        if (sent.has(itemKey)) {
            if (itemEdits) {
                changes[itemKey] = itemEditsMutation(itemEdits);
                delete expected[itemKey];
            }
            store.itemFlight = { value: sent.get(itemKey), edits: itemEdits };
        }
        setStoreState('saving');
        let refused = false;
        const saving = (async () => {
            try {
                const result = await host.patch(changes, expected);
                // Signed out (or someone else signed in, or another server) meanwhile: not this session's any more.
                if (!sameSession(mark)) return false;
                const stored = result && result.values && typeof result.values === 'object' ? result.values : changes;
                for (const [key, value] of sent) {
                    const saved = key in stored ? stored[key] : changes[key];
                    if (store.values.has(key) && store.values.get(key) !== value) {
                        // Edited again meanwhile: the next save expects what this one stored.
                        store.base.set(key, copy(saved));
                        if (key === itemKey && store.itemMode === 'entries') {
                            const savedEntries = new Map((saved || []).map(e => [e.ItemId, e]));
                            for (const [id, edit] of itemEdits || []) {
                                const pending = store.itemEdits.get(id);
                                if (pending === edit) store.itemEdits.delete(id);
                                // Advance only our own acknowledged operation; remote entries
                                // keep the Expected stamp captured when the user acted.
                                else if (pending) store.itemEdits.set(id, { ...pending, expected: copy(savedEntries.get(id)) });
                            }
                            store.values.set(key, rebaseItemEdits(saved));
                        }
                    } else {
                        store.values.delete(key);
                        store.base.delete(key);
                        if (key === itemKey) { store.itemEdits.clear(); store.itemMode = null; }
                    }
                }
                store.failed = [];
                notify({ type: 'saved', values: Object.fromEntries(Array.from(sent.keys()).map((key) => [key, key in stored ? stored[key] : changes[key]])) });
                return true;
            } catch (err) {
                const rejection = await rejectionOf(err);
                const conflicts = err?.status === 409 ? rejection?.conflicts : null;
                const unwritten = (conflicts && Object.keys(conflicts).length > 0)
                    || (typeof rejection?.error === 'string' && rejection.error.includes(itemKey));
                if (!sameSession(mark)) return false;
                // Only a definitive rejection establishes that this request did not write.
                // Unknown outcomes retain the next intent and require acknowledgement,
                // even when a subsequent edit cancels its apparent delta.
                for (const [id, edit] of itemEdits || []) {
                    const pending = store.itemEdits.get(id);
                    if (!pending) continue;
                    if (!unwritten) store.itemEdits.set(id, { ...pending, acknowledge: true });
                    else if (pending !== edit) store.itemEdits.set(id, { ...pending, expected: edit.expected });
                }
                if (conflicts && Object.keys(conflicts).length) {
                    for (const [key, theirs] of Object.entries(conflicts)) store.conflicts.set(key, theirs);
                    refused = true;
                } else {
                    console.error('🪼 Jellyfin Enhanced: could not save the Media Tags settings', err);
                    store.failed = Array.from(sent.keys());
                }
                return false;
            } finally {
                if (mark.generation === store.generation) { store.saving = null; store.itemFlight = null; }
            }
        })();
        store.saving = saving;
        return saving.then((ok) => {
            if (!sameSession(mark)) return false;
            // Refused fields wait for a choice; the others in that request still save.
            if (refused) return flushStore();
            if (!ok) setStoreState('error');
            else if (store.values.size) return flushStore();
            else setStoreState(store.conflicts.size ? 'conflict' : 'saved');
            return ok && !store.conflicts.size;
        });
    }

    /**
     * Settle the fields another administrator changed: keep this page's
     * values (saved again over theirs) or take theirs.
     * @param {boolean} mine
     * @returns {Promise<boolean>} Whether everything pending is saved afterwards.
     */
    function resolveConflicts(mine) {
        const theirs = Object.fromEntries(store.conflicts);
        store.conflicts.clear();
        for (const [key, value] of Object.entries(theirs)) {
            if (mine) {
                store.base.set(key, copy(value));
                if (key === 'TagLookItemOverrides' && store.itemMode === 'entries') {
                    const entries = new Map((value || []).map(e => [e.ItemId, e]));
                    for (const [id, edit] of store.itemEdits) store.itemEdits.set(id, { ...edit, expected: copy(entries.get(id)) });
                    store.values.set(key, rebaseItemEdits(value));
                }
            }
            else {
                store.values.delete(key);
                store.base.delete(key);
                if (key === 'TagLookItemOverrides') { store.itemEdits.clear(); store.itemMode = null; }
            }
        }
        if (!mine) notify({ type: 'saved', values: theirs, theirs: true });
        return flushStore();
    }

    /** Queue a save after a short pause (a burst of changes saves once). */
    function scheduleStore() {
        clearTimeout(store.timer);
        setStoreState('saving');
        store.timer = setTimeout(() => {
            store.timer = null;
            flushStore();
        }, SAVE_DELAY_MS);
    }

    /**
     * A field's name for the save indicator: its control's label, else the
     * field name spelled out.
     * @param {string} key - PluginConfiguration field.
     * @returns {string}
     */
    function fieldName(key) {
        for (const s of sections) {
            for (const f of s.fields || []) {
                if (f.key === key || f.orderKey === key) return JE.t(f.label);
            }
        }
        return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    }

    // ── The page ───────────────────────────────────────────────────────

    /**
     * Build the page into its root and wire it.
     * @param {HTMLElement} root - The .je-tag-admin element.
     * @param {Object} config - The plugin configuration (the page's working copy).
     * @param {{api?: Object, confirm?: Function, now?: () => number}} [options] - Host
     *   hooks (tests): api = { get(): Promise<config>, patch(changes, expected): Promise<{values}> }
     *   (patch rejects with {status: 409, json()} → {conflicts} when refused),
     *   confirm(text, title): Promise<boolean>.
     * @returns {Object} The page context.
     */
    function createPage(root, config, options = {}) {
        const host = options.api || {
            get: () => ApiClient.getPluginConfiguration(PLUGIN_ID),
            patch: (changes, expected) => ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl('/JellyfinEnhanced/admin/configuration'),
                data: JSON.stringify({ Changes: changes, Expected: expected }),
                contentType: 'application/json',
                dataType: 'json',
            }),
        };
        config = { ...config };
        for (const section of sections) for (const field of section.fields || []) if (field.secret) delete config[field.key];
        checkSession();
        store.host = host;
        const contextMark = sessionMark();
        // Edits a failed save left behind (another view's) show here too.
        for (const [key, value] of store.values) config[key] = value;
        let disposed = false;
        // Jellyfin keeps the root when it keeps the view: every listener on it
        // goes with this page's lifetime, so a rebuilt page never doubles them.
        const lifetime = new AbortController();
        const { signal } = lifetime;
        let preview = null;
        let snackTimer = null;
        /** @type {Object<string, boolean>} open state of each group row */
        const openGroups = new Map();

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

        // ── Saving (the edits live in the document-wide store) ──
        /** Draw the save indicator from the store: saved, saving, or not saved with the fields and Retry. */
        const drawSaveState = () => {
            const state = store.state;
            savedChip.dataset.state = state;
            const names = (keys) => Array.from(new Set(keys.map(fieldName))).join(', ');
            if (state === 'conflict') {
                savedChip.innerHTML = `<span>${tx('admin_tags_conflict', { fields: names(Array.from(store.conflicts.keys())) })}</span>`
                    + `<button type="button" data-je-keep>${tx('admin_tags_keep_mine')}</button><button type="button" data-je-theirs>${tx('admin_tags_take_theirs')}</button>`;
            } else if (state === 'error') {
                const fields = names(store.failed.length ? store.failed : Array.from(store.values.keys()));
                savedChip.innerHTML = `<span>${fields ? tx('admin_tags_save_failed_fields', { fields }) : tx('admin_tags_save_failed')}</span><button type="button" data-je-retry>${tx('admin_tags_retry')}</button>`;
            } else savedChip.innerHTML = tx(state === 'saving' ? 'admin_tags_saving' : 'admin_tags_saved');
        };
        savedChip.addEventListener('click', (e) => {
            const target = /** @type {HTMLElement} */ (e.target);
            if (target.closest('[data-je-retry]')) flush();
            else if (target.closest('[data-je-keep]')) resolveConflicts(true);
            else if (target.closest('[data-je-theirs]')) resolveConflicts(false);
        }, { signal });
        /** @returns {Promise<boolean>} Whether everything pending is saved. */
        const flush = () => !disposed && sameSession(contextMark) ? flushStore() : Promise.resolve(false);
        const schedule = scheduleStore;
        /**
         * The store changed state, or a save went through: redraw the
         * indicator; after a save, take the stored values into this view.
         * The preview's styles are fetched again after a Tag Styles save, or
         * when another administrator's values were taken.
         * @param {{type: string, values?: Object, theirs?: boolean}} event
         */
        const onStore = (event) => {
            if (disposed) return;
            let moved = false;
            if (event.type === 'saved' && event.values) {
                for (const [key, value] of Object.entries(event.values)) {
                    const shown = store.values.has(key) && key === 'TagLookItemOverrides' ? store.values.get(key) : value;
                    if ((store.values.has(key) && key !== 'TagLookItemOverrides') || sameValue(config[key], shown)) continue;
                    // The server stored something else (it normalised the value, or theirs was taken).
                    config[key] = copy(shown);
                    moved = true;
                }
            }
            if (moved) {
                for (const s of sections) s.load?.(ctx, bodyOf(s));
                refresh();
            }
            if (event.type === 'saved' && (event.theirs || (event.values && Object.keys(event.values).some((key) => key.startsWith('TagStyle'))))) loadPreviewStyles();
            drawSaveState();
        };
        store.views.add(onStore);

        /** The fields this page may write (the server accepts no others). */
        const owned = pageFields();
        /**
         * Write configuration fields, save them and redraw what depends on them.
         * @param {Object<string, *>} values - Field → value.
         * @param {{redraw?: boolean, itemEdit?: boolean}} [opts] - itemEdit captures per-entry intent; otherwise this is a replacement.
         */
        function setMany(values, opts = {}) {
            // A late callback of a page that is gone must not save anything.
            if (disposed) return;
            let edited = false;
            for (const [key, value] of Object.entries(values)) {
                if (!owned.has(key)) {
                    // The server refuses it anyway: a section writing an undeclared field is a bug.
                    console.error(`🪼 Jellyfin Enhanced: the Media Tags page does not declare ${key}; not saved`);
                    continue;
                }
                // Editors hand back whole documents (the layout writes its order, caps and
                // profiles together): a field that did not change is not an edit, so it
                // neither saves nor can conflict with another administrator's change.
                if (!store.values.has(key) && sameValue(config[key], value)) continue;
                // What the server should still hold when this edit is saved.
                if (!store.values.has(key) && !store.base.has(key)) store.base.set(key, copy(config[key]));
                if (key === 'TagLookItemOverrides') {
                    // Until the whole list is acknowledged, entry edits fold into that
                    // replacement, including while its request is pending or failed.
                    const replacing = store.itemMode === 'replace';
                    if (opts.itemEdit && !replacing) {
                        const delta = JE.core.tagLook.itemOverrideMutation(config[key], value);
                        const sets = new Map(delta.Set.map(e => [e.ItemId, e]));
                        for (const id of Object.keys(delta.Expected)) {
                            const previous = store.itemEdits.get(id);
                            const inFlight = previous && store.itemFlight?.edits?.get(id) === previous;
                            store.itemEdits.set(id, { value: copy(sets.get(id)), expected: previous && !inFlight ? previous.expected : copy(delta.Expected[id]), acknowledge: !!previous?.acknowledge });
                        }
                        store.itemMode = 'entries';
                    } else {
                        store.itemEdits.clear();
                        store.itemMode = 'replace';
                    }
                }
                config[key] = value;
                store.values.set(key, value);
                edited = true;
            }
            if (edited) schedule();
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
        }, { signal });

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
        }, { signal });

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
        }, { signal });
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
        }, { signal });
        // Any element with data-je-goto="tab[:group]" opens it.
        root.addEventListener('click', (e) => {
            const goto = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-je-goto]'));
            if (!goto) return;
            e.preventDefault();
            const [tab, group] = String(goto.dataset.jeGoto).split(':');
            openTab(tab, { group: group || null, focus: true });
        }, { signal });

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
            openGroups.set(group, open);
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
        }, { signal });

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
        }, { signal });
        const mount = /** @type {HTMLElement} */ (root.querySelector('.je-ta-preview-mount'));
        const createPreview = JE.internals?.enhancedUi?.createTagPreview;
        if (typeof createPreview === 'function') {
            preview = createPreview(mount, { source: () => ({ settings: seedUser(config), plugin: config }) });
        }
        // Tag Styles: the preview shows the saved server styles (what a new
        // user gets), scoped to it; the signed-in user's page-wide styles
        // leave it alone (tag-styles.js skips marked elements).
        const previewBody = /** @type {HTMLElement} */ (root.querySelector('#jeTaPreviewBody'));
        previewBody.setAttribute(JE.tagStyles?.SCOPE_ATTR || 'data-je-tag-styles-scope', '');
        let stylesSeq = 0;
        /**
         * Fetch the server's effective web Tag Styles (GET tag-styles without a
         * preset: the administrator's) and style the preview with them.
         * @returns {Promise<void>}
         */
        async function loadPreviewStyles() {
            const seq = ++stylesSeq;
            const mark = sessionMark();
            let styles;
            try {
                styles = await ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/JellyfinEnhanced/tag-styles'), dataType: 'json' });
            } catch (err) {
                if (!disposed && sameSession(mark)) console.warn('🪼 Jellyfin Enhanced: could not load the Tag Styles for the preview', err);
                return;
            }
            // Another session's styles (a server switch resets the session and disposes this view first).
            if (!sameSession(mark) || disposed || seq !== stylesSeq) return;
            const css = typeof JE.tagStyles?.buildCss === 'function' ? JE.tagStyles.buildCss(styles || {}, '#jeTaPreviewBody') : '';
            if (css) JE.core.ui.injectCss(PREVIEW_STYLE_ID, css);
            else JE.core.ui.removeCss(PREVIEW_STYLE_ID);
        }
        /** Outline the group being edited in the preview. */
        function syncSpotlight() {
            if (!preview) return;
            const open = current() === 'groups' ? Array.from(openGroups.keys()).find((g) => openGroups.get(g)) : null;
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
         * Ask before a destructive action. A "yes" given after the administrator
         * signed out, another one signed in or the view was torn down is a "no":
         * the action would otherwise run with the next session's credentials.
         * @param {string} text
         * @param {string} title
         * @returns {Promise<boolean>}
         */
        async function confirmAction(text, title) {
            const mark = sessionMark();
            const ok = options.confirm ? await options.confirm(text, title) : await askConfirm(text, title);
            return !!ok && !disposed && sameSession(mark);
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

        /** Tear the page down: the preview and its timers. Pending edits stay in the store. */
        function dispose() {
            if (disposed) return;
            disposed = true;
            lifetime.abort();
            store.views.delete(onStore);
            clearTimeout(snackTimer);
            preview?.dispose();
            preview = null;
            JE.core.ui.removeCss(PREVIEW_STYLE_ID);
            for (const s of sections) s.dispose?.(ctx);
        }

        /**
         * Replace the working copy with a fresh configuration (page shown again).
         * Fields with unsaved edits keep the edited values. The preview's
         * styles are fetched again too: Tag Styles may have been saved
         * elsewhere (the main page, another administrator, the API).
         * @param {Object} fresh
         */
        function reload(fresh) {
            if (disposed) return;
            const keep = protectedFields();
            for (const key of Object.keys(fresh)) if (!keep.has(key)) config[key] = fresh[key];
            for (const { f } of allFields) if (f.secret && !keep.has(f.key)) delete config[f.key];
            for (const s of sections) s.load?.(ctx, bodyOf(s));
            refresh();
            loadPreviewStyles();
        }

        const ctx = {
            root, config, t: JE.t, tx, esc,
            /** @param {string} key @param {*} value */
            set: (key, value) => setMany({ [key]: value }, { itemEdit: true }),
            isCurrent: () => !disposed && sameSession(contextMark),
            setMany, flush, refresh, reload, openTab, setGroupOpen, confirm: confirmAction, snack, announce, dispose,
            pageUrl, mainPageUrl,
            /** @returns {string} The tab shown now. */
            currentTab: current,
            /** @returns {boolean} Whether some change is not saved yet. */
            pending: hasPending,
            /** @returns {boolean} Whether the page was torn down (late asynchronous answers are dropped). */
            get disposed() { return disposed; },
            /** Aborted when the page is torn down: pass it to listeners on elements that outlive the page. */
            signal,
            get preview() { return preview; },
            layout: JE.core?.tagLayout || null,
            fieldValue,
        };

        for (const s of sections) s.render?.(ctx, bodyOf(s));
        refresh({ controls: false });
        drawSaveState();
        loadPreviewStyles();
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
     * Ask with the dashboard's dialog (the browser's when it is missing).
     * @param {string} text
     * @param {string} title
     * @returns {Promise<boolean>}
     */
    function askConfirm(text, title) {
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

    /** @returns {boolean} Whether the URL shows a Media Tags view. */
    function onMediaTagsPage() {
        return window.location.hash.includes(`name=${PAGE_NAME}`);
    }

    /**
     * The page was hidden while an edit was not saved. Jellyfin cannot cancel
     * a view change, so save now and, when that fails and no other Media Tags
     * view took over, ask whether to go back to retry. The edits stay pending
     * in the store either way and the next Media Tags view shows them.
     * @returns {Promise<void>}
     */
    async function leaveWithPending() {
        const mark = sessionMark();
        if (!hasPending()) return;
        const ok = await flushStore();
        // Signed out meanwhile: the edits went with that session, nothing to go back to.
        if (ok || !sameSession(mark) || onMediaTagsPage()) return;
        const names = Array.from(new Set((store.failed.length ? store.failed : Array.from(store.values.keys())).map(fieldName))).join(', ');
        const back = await askConfirm(JE.t('admin_tags_leave_confirm', { fields: names }), JE.t('admin_tags_leave_title'));
        // The answer belongs to the session that was asked: after a sign-out or another sign-in it navigates no one.
        if (back && sameSession(mark) && !onMediaTagsPage()) window.location.href = pageUrl();
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
        queue = queue.then(() => show(page)).catch((err) => {
            console.error('🪼 Jellyfin Enhanced: the Media Tags page failed to load', err);
            const root = page.querySelector('.je-tag-admin');
            if (root) showLoadError(page, /** @type {HTMLElement} */ (root));
            return null;
        });
        return queue;
    }

    /**
     * One activation (activate runs them one after another). Every answer is
     * checked against the session it was asked in (sessionMark/sameSession,
     * reconciling the ApiClient identity after each await): another
     * session's settings are never shown. When someone is signed in now
     * (another server, another administrator), the page starts again for
     * them; signed out, it stays empty.
     * @param {HTMLElement} page
     * @returns {Promise<Object|null>} The page context.
     */
    async function show(page) {
        const root = /** @type {HTMLElement} */ (page.querySelector('.je-tag-admin'));
        detectTheme(root);
        // Another administrator (or server) since the last view: start from nothing.
        const mark = sessionMark();
        const again = () => (signedIn() ? show(page) : null);
        if (active && active.page === page && root.contains(active.ctx.root.firstElementChild)) {
            let fresh = null;
            try { fresh = await ApiClient.getPluginConfiguration(PLUGIN_ID); } catch (err) { if (sameSession(mark)) console.warn('🪼 Jellyfin Enhanced: could not reload the configuration', err); }
            // Signed out or another session while it loaded: the reset emptied the view.
            if (!sameSession(mark)) return again();
            if (!active) return null;
            if (fresh) active.ctx.reload(fresh);
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
            if (!sameSession(mark)) return again();
        }
        Dashboard.showLoadingMsg?.();
        let config;
        let failure = null;
        try {
            config = await ApiClient.getPluginConfiguration(PLUGIN_ID);
        } catch (err) {
            failure = err;
        } finally {
            Dashboard.hideLoadingMsg?.();
        }
        // The previous session's settings (or failure), answered after it ended: not shown to anyone.
        if (!sameSession(mark)) return again();
        if (failure) {
            console.error('🪼 Jellyfin Enhanced: could not load the Media Tags settings', failure);
            showLoadError(page, root);
            return null;
        }
        const ctx = createPage(root, config);
        active = { page, root, ctx };
        return ctx;
    }

    /**
     * The settings could not be loaded: say so in the page, with Retry
     * (which activates the page again), instead of the loading line.
     * @param {HTMLElement} page
     * @param {HTMLElement} root
     */
    function showLoadError(page, root) {
        root.innerHTML = `<div class="je-ta-wait je-ta-load-error" role="alert"><p>${tx('admin_tags_load_failed')}</p>`
            + `<button type="button" class="je-ta-button" data-je-reload><span class="material-icons" aria-hidden="true">refresh</span>${tx('admin_tags_retry')}</button></div>`;
        const retry = /** @type {HTMLButtonElement} */ (root.querySelector('[data-je-reload]'));
        retry.addEventListener('click', () => {
            retry.disabled = true;
            activate(page);
        }, { once: true });
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
            page.addEventListener('viewbeforehide', () => { if (active?.page === page) leaveWithPending(); });
        }
        if (!unloadWired) {
            unloadWired = true;
            // Leaving the dashboard (reload, closing the tab) with an edit not saved: the browser asks.
            window.addEventListener('beforeunload', (e) => {
                if (!hasPending()) return;
                flushStore();
                e.preventDefault();
                e.returnValue = '';
            });
        }
        return activate(page);
    }

    // Signing out, another administrator or another server: the edits and the view go with the old session,
    // unless the page noticed first (checkSession) and already belongs to the new one. JE.session reports a
    // sign-in or sign-out before the ApiClient has the new credentials, so the change names who comes next.
    JE.session?.onUserChange?.('admin-tags', (change) => {
        if (!change || store.owner !== `${change.serverId || ''}|${change.userId || ''}`) resetSession();
    });

    JE.adminTags = {
        TABS,
        SECTION_FILES,
        SEEDED_KEYS,
        PAGE_NAME,
        PLUGIN_ID,
        sections,
        registerSection,
        pageFields,
        seedUser,
        pageUrl,
        mainPageUrl,
        fieldHtml,
        fieldsHtml,
        fieldValue,
        controlValue,
        createPage,
        mount,
        activate,
        requestedTarget,
        /** @returns {{state: string, fields: string[], failed: string[]}} The unsaved edits (tests, diagnostics). */
        pendingState: () => ({ state: store.state, fields: Array.from(store.values.keys()), failed: store.failed.slice() }),
        leaveWithPending,
    };
})(window.JellyfinEnhanced);
