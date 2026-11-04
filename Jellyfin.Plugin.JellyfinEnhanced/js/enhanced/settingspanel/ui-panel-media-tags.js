/**
 * @file The Media Tags hub: the settings panel section that gathers every
 * poster tag control behind one tab strip, with a live preview beside it.
 *
 *   Layout         layout tiles, label density, the quick switches, and
 *                  presets with import and export (ui-panel-tag-portable.js)
 *   Groups         the group editor (ui-panel-tag-editor.js)
 *   Status badges  the status badge families and the admin's time windows
 *   Rules & locks  the tag look rules and locked items (ui-panel-tag-looks.js)
 *   Colours        the user's colour preset (only while the admin allows
 *                  one), and for admins the way to the colour editor
 *   Server         admins only: links to the Media Tags admin page
 *
 * Every control reads and writes the per-user setting it always did; the
 * ids the settings wiring (ui-panel-settings.js) binds are kept. Admin-only
 * content is never rendered for other users. The preview
 * (ui-panel-tag-preview.js) is a right-hand column on a wide pane and a
 * one-line strip under the tabs on a narrow one; it is built the first time
 * the section shows and disposed with the panel. The panel's settings search
 * finds each control here through the provider this module registers.
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    const LAYOUTS = ['corners', 'bands', 'caption', 'summary', 'minimal'];
    const PRESETS = ['default', 'glass', 'outline', 'dark', 'light', 'mono', 'poster'];
    /** The Media Tags administrator page (Configuration/mediaTagsPage.html). */
    const ADMIN_PAGE_NAME = 'JellyfinEnhancedMediaTags';
    const TAB_STORE_PREFIX = 'JE_mediaTagsTab:';

    /**
     * The status badge families: the setting each switch writes (ids kept from
     * the group editor, so ui-panel-settings.js saves them), its built-in
     * default, its name and description, the sample chip it shows, and the
     * admin's time window it is limited by.
     */
    const BADGE_FAMILIES = [
        { key: 'statusTagsJustAdded', id: 'statusTagsJustAddedToggle', fallback: true, nameKey: 'status_tag_just_added', descKey: 'panel_media_tags_badge_just_added_desc', chip: ['added', 'added', 'status_tag_just_added'], windowKey: 'panel_media_tags_badge_window_added', windowSetting: 'StatusTagsJustAddedDays', windowFallback: 7 },
        { key: 'statusTagsNewRelease', id: 'statusTagsNewReleaseToggle', fallback: true, nameKey: 'panel_media_tags_badge_new_release', descKey: 'panel_settings_ui_status_tags_new_release', chip: ['new', 'newMovie', 'status_tag_new_movie'], windowKey: 'panel_media_tags_badge_window_new', windowSetting: 'StatusTagsNewReleaseDays', windowFallback: 30 },
        { key: 'statusTagsTrending', id: 'statusTagsTrendingToggle', fallback: true, nameKey: 'recommendations_trending', descKey: 'panel_media_tags_badge_trending_desc', chip: ['trending', 'trending', 'status_tag_trending_today'] },
        { key: 'statusTagsSchedule', id: 'statusTagsScheduleToggle', fallback: true, nameKey: 'panel_media_tags_badge_schedule', descKey: 'panel_settings_ui_status_tags_schedule', chip: ['schedule', 'airing_today', 'status_tag_airing_today'] },
        { key: 'statusTagsMilestones', id: 'statusTagsMilestonesToggle', fallback: true, nameKey: 'panel_media_tags_badge_milestones', descKey: 'panel_settings_ui_status_tags_milestones', chip: ['milestone', 'season_finale', 'status_tag_season_finale'] },
        { key: 'statusTagsSeriesStatus', id: 'statusTagsSeriesStatusToggle', fallback: false, nameKey: 'panel_media_tags_badge_series_status', descKey: 'panel_settings_ui_status_tags_series_status', chip: ['status', 'returning', 'status_tag_returning'] },
        { key: 'statusTagsScenes', id: 'statusTagsScenesToggle', fallback: false, nameKey: 'panel_media_tags_badge_scenes', descKey: 'panel_settings_ui_status_tags_scenes', chip: ['scenes', 'post_credits', 'status_tag_post_credits'] },
        { key: 'statusTagsLeaving', id: 'statusTagsLeavingToggle', fallback: false, nameKey: 'common_leaving_soon', descKey: 'panel_media_tags_badge_leaving_desc', chip: ['leaving', 'leaving', 'status_tag_leaving_days', { days: 5 }], requires: 'LeavingSoonAvailable', requiresKey: 'panel_media_tags_badge_leaving_unavailable' },
        { key: 'statusTagsDirectPlay', id: 'statusTagsDirectPlayToggle', fallback: false, nameKey: 'panel_media_tags_badge_direct_play', descKey: 'panel_media_tags_badge_direct_play_desc', chip: ['playback', 'direct_play', 'status_tag_transcode'] },
    ];

    /** The admin pointers: the Media Tags admin page tab each one opens. */
    const SERVER_LINKS = [
        { nameKey: 'panel_media_tags_server_defaults', descKey: 'panel_media_tags_server_defaults_desc', tab: 'layout' },
        { nameKey: 'panel_media_tags_server_colours', descKey: 'panel_media_tags_server_colours_desc', tab: 'colours' },
        { nameKey: 'panel_media_tags_server_cache', descKey: 'panel_media_tags_server_cache_desc', tab: 'server' },
        { nameKey: 'panel_media_tags_server_native', descKey: 'panel_media_tags_server_native_desc', tab: 'server' },
    ];

    /** Built-in colours of the chips a preset tile shows, for parts a preset leaves alone. */
    const CHIP_DEFAULTS = {
        quality: { background: 'rgba(189, 5, 232, 0.95)', color: '#ffffff', border: 'transparent' },
        status: { background: 'rgba(15, 15, 15, 0.72)', color: '#ffffff', border: 'rgba(255, 255, 255, 0.18)' },
        rating: { background: 'rgba(0, 0, 0, 0.85)', color: '#ffc107', border: 'transparent' },
        genre: { background: 'rgba(10, 10, 10, 0.8)', color: '#E0E0E0', border: 'rgba(255, 255, 255, 0.2)' },
    };

    /** The genre a preset tile shows when the administrator coloured none of their own. */
    const GENRE_SAMPLE = 'drama';

    /**
     * The Poster preset's tile: each chip in the colours a different artwork
     * gives it (a red, a blue and a teal poster), through the same
     * normalisation as the cards (tags/tag-poster-colours.js).
     */
    const POSTER_SAMPLE_ART = { quality: [178, 34, 34], status: [30, 60, 140], rating: [20, 120, 130], genre: [96, 40, 128] };

    const escapeHtml = (value) => JE.escapeHtml(String(value));
    /** @param {string} key @param {Object} [params] @returns {string} Translated and escaped. */
    const tx = (key, params) => escapeHtml(JE.t(key, params));

    /** @returns {boolean} Whether the signed-in user is an administrator (server-computed flag). */
    const isAdmin = () => (JE.helpers?.isAdmin ? JE.helpers.isAdmin() : JE.currentSettings?.isAdmin === true);
    /** @returns {boolean} Whether the admin lets users pick their own colour preset. */
    const presetsAllowed = () => JE.pluginConfig?.TagStylesAllowUserPreset === true;

    /**
     * The tabs this user gets, in order. Colours only while presets are
     * allowed (admins always, for the colour editor); Server for admins only.
     * @returns {Array<{id: string, nameKey: string, shortKey?: string, admin?: boolean}>}
     */
    function tabsFor() {
        const tabs = [
            { id: 'layout', nameKey: 'common_layout' },
            { id: 'groups', nameKey: 'common_groups' },
            { id: 'badges', nameKey: 'panel_media_tags_tab_badges', shortKey: 'common_badges' },
            { id: 'rules', nameKey: 'panel_media_tags_tab_rules', shortKey: 'common_rules' },
        ];
        if (presetsAllowed() || isAdmin()) tabs.push({ id: 'colours', nameKey: 'common_colours' });
        if (isAdmin()) tabs.push({ id: 'server', nameKey: 'common_server', admin: true });
        return tabs;
    }

    /**
     * Resolve a boolean setting: user override, then admin default, then the built-in default.
     * @param {string} userKey
     * @param {boolean} fallback
     * @returns {boolean}
     */
    function effectiveBool(userKey, fallback) {
        const u = JE.currentSettings?.[userKey];
        if (typeof u === 'boolean') return u;
        const a = JE.pluginConfig?.[userKey.charAt(0).toUpperCase() + userKey.slice(1)];
        return typeof a === 'boolean' ? a : fallback;
    }

    /**
     * The Media Tags admin page, optionally opened at one tab (the page
     * reads `tab`; see js/enhanced/admintags/admin-tags.js).
     * @param {string} [tab] - Tab id: layout, colours, badges, server, …
     * @returns {string}
     */
    function configUrl(tab) {
        const base = `${window.location.origin}${window.location.pathname}`;
        return `${base}#/configurationpage?name=${ADMIN_PAGE_NAME}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}`;
    }

    /** @returns {any} The effective layout settings (layout, density, edge spacing), read fresh. */
    function layoutConf() {
        const L = JE.core?.tagLayout;
        if (!L) return { layout: 'corners', density: 'full', edge: 'default' };
        L.invalidateSettings();
        return L.normalizeSettings();
    }

    // ── Markup ─────────────────────────────────────────────────────────

    /**
     * A checkbox row (quick switch): the input keeps its old id.
     * @param {string} id
     * @param {boolean} checked
     * @param {string} nameKey
     * @param {string} descKey
     * @returns {string}
     */
    function switchRow(id, checked, nameKey, descKey) {
        return `
            <label class="je-mth-switch">
                <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} aria-describedby="${id}Desc">
                <span class="je-mth-switch-text">
                    <span class="je-mth-switch-name" data-je-label>${tx(nameKey)}</span>
                    <span class="je-mth-switch-desc" id="${id}Desc">${tx(descKey)}</span>
                </span>
            </label>`;
    }

    // Per-shape settings live here, apart from the default layout and group editor.
    /**
     * One shape's reduced profile editor: position pills and chip cap steppers.
     * Uses the controller's group/slot vocabulary; the full group row also owns
     * enable switches, category filters and reordering, which remain global.
     * @param {string} shape
     * @returns {string}
     */
    function shapeRowHtml(shape) {
        const L = JE.core.tagLayout;
        const own = L.normalizeSettings().shapes[shape];
        const conf = L.resolveLayout({ shape });
        const shapeName = JE.t(`tag_shapes_${shape}`);
        // Collapsed, the card says what the shape's look is; its fields open on request.
        const summary = [JE.t(L.VOCABULARY_KEYS.layout[conf.layout]), JE.t(`panel_settings_ui_tag_density_${conf.density}`),
            own?.tagScale ? L.sizeLabel('scale', own.tagScale) : ''].filter(Boolean).join(' · ');
        const controls = own ? `
            <details class="je-mth-shape-more" data-shape-more ${openShapes.has(shape) ? 'open' : ''}>
            <summary class="je-mth-shape-summary"><span class="je-mth-shape-summary-text">${escapeHtml(summary)}</span><span class="je-mth-shape-summary-action">${tx('tag_shapes_edit')}<span class="material-icons" aria-hidden="true">expand_more</span></span></summary>
            <div class="je-mth-shape-fields">
                <label>${tx('panel_settings_ui_tag_layout')}<select data-shape-action="layout" aria-label="${tx('tag_shapes_layout_for', { shape: shapeName })}">
                    ${LAYOUTS.map(id => `<option value="${id}" ${conf.layout === id ? 'selected' : ''}>${tx(JE.core.tagLayout.VOCABULARY_KEYS.layout[id])}</option>`).join('')}
                </select></label>
                <label>${tx('panel_settings_ui_tag_density')}<select data-shape-action="density" aria-label="${tx('tag_shapes_density_for', { shape: shapeName })}">
                    ${['full', 'compact'].map(id => `<option value="${id}" ${conf.density === id ? 'selected' : ''}>${tx(`panel_settings_ui_tag_density_${id}`)}</option>`).join('')}
                </select></label>
                ${['scale', 'gap'].map(kind => {
                    const key = kind === 'scale' ? 'tagScale' : 'tagGap';
                    const choices = kind === 'scale' ? L.TAG_SCALES : L.TAG_GAPS;
                    return `<label>${tx(`tag_${kind}_label`)}<select data-shape-action="${key}" aria-label="${escapeHtml(shapeName)}: ${tx(`tag_${kind}_label`)}">
                        <option value="" ${!own[key] ? 'selected' : ''}>${tx('tag_size_inherit')}</option>
                        ${Object.keys(choices).map(id => `<option value="${id}" ${own[key] === id ? 'selected' : ''}>${escapeHtml(JE.core.tagLayout.sizeLabel(kind, id))}</option>`).join('')}
                    </select></label>`;
                }).join('')}
                <button type="button" class="je-mth-button" data-shape-action="recommended">${tx('tag_shapes_recommended')}</button>
            </div>
            <div class="je-mth-shape-groups">${L.DEFAULT_ORDER.map(group => {
                const groupName = JE.t(JE.core.tagLayout.VOCABULARY_KEYS.group[`${group === 'ageRating' ? 'age_rating' : group}`]);
                const cap = conf.caps[group];
                return `<div class="je-mth-shape-group" data-shape-group="${group}">
                    <span class="je-mth-label">${escapeHtml(groupName)}</span>
                    <div class="je-mth-shape-positions" role="group" aria-label="${tx('tag_shapes_position_for', { group: groupName, shape: shapeName })}">
                        ${L.LAYOUT_SLOTS[conf.layout].filter(slot => slot !== 'dots' || group === 'quality').map(slot => `<button type="button" data-shape-action="slot" data-value="${slot}" aria-pressed="${conf.slots[group] === slot}">${tx(slot === 'off' ? 'panel_settings_ui_tag_slot_off' : JE.core.tagLayout.VOCABULARY_KEYS.slot[`${conf.layout}_${slot}`])}</button>`).join('')}
                    </div>
                    <div class="je-mth-shape-cap" data-je-cap-control ${L.singleChipGroup(group) ? 'hidden' : ''} role="group" aria-label="${tx('tag_shapes_cap_for', { group: groupName, shape: shapeName })}">
                        <button type="button" data-shape-action="cap" data-value="-1" ${internal.tagGroupEditorData.stepCap(cap, -1, { capAll: true }) === null ? 'disabled' : ''} aria-label="${tx('tag_shapes_fewer', { group: groupName })}">−</button>
                        <output aria-live="polite">${cap === 0 ? tx('panel_settings_ui_tag_editor_summary_all') : cap}</output>
                        <button type="button" data-shape-action="cap" data-value="1" ${internal.tagGroupEditorData.stepCap(cap, 1, { capAll: true }) === null ? 'disabled' : ''} aria-label="${tx('tag_shapes_more', { group: groupName })}">+</button>
                    </div>
                </div>`;
            }).join('')}</div>
            </details>` : '';
        return `<section class="je-mth-card je-mth-shape" data-shape="${shape}" aria-labelledby="jeShape-${shape}">
            <h4 class="je-mth-card-title" id="jeShape-${shape}">${escapeHtml(shapeName)}</h4>
            <label class="je-mth-shape-toggle"><input type="checkbox" data-shape-action="enabled" ${own ? 'checked' : ''}>${tx('tag_shapes_different')}</label>
            ${controls}
        </section>`;
    }

    /** The shape cards opened this session (kept when the cards are drawn again). */
    const openShapes = new Set();

    /** @returns {string} The independently editable looks for landscape cards and list rows. */
    function shapesHtml() {
        return JE.core?.tagLayout ? JE.core.tagLayout.SHAPES.map(shapeRowHtml).join('') : '';
    }

    /** Size or gap segmented control, using the layout controller's validated choices.
     * @param {string} kind @param {Object} conf @returns {string}
     */
    function sizeControlHtml(kind, conf) {
        const name = kind === 'scale' ? 'Scale' : 'Gap';
        const choices = kind === 'scale' ? JE.core.tagLayout.TAG_SCALES : JE.core.tagLayout.TAG_GAPS;
        return `<div class="je-mth-density">
            <div class="je-mth-field-text">
                <span class="je-mth-label" id="jeMth${name}Label">${tx(`tag_${kind}_label`)}</span>
                <span class="je-mth-hint" id="jeMth${name}Desc">${tx(`tag_${kind}_desc`)}</span>
            </div>
            <div class="je-mth-pills" id="jeTag${name}Choice" role="radiogroup" aria-labelledby="jeMth${name}Label" aria-describedby="jeMth${name}Desc">
                ${Object.keys(choices).map(value => `<label class="je-mth-pill"><input type="radio" name="jeTag${name}" value="${value}" ${conf[`tag${name}`] === value ? 'checked' : ''}><span data-je-label>${escapeHtml(JE.core.tagLayout.sizeLabel(kind, value))}</span></label>`).join('')}
            </div>
        </div>`;
    }

    /** Corners edge spacing choices (core/tag-layout.js EDGE_SPACINGS), in display order. */
    const EDGES = ['default', 'tight', 'flush'];

    /** @returns {string} The Layout tab: tiles, density, edge spacing and the quick switches. */
    function layoutPanelHtml() {
        const conf = layoutConf();
        const tiles = LAYOUTS.map((id) => `
            <label class="je-mth-tile">
                <input type="radio" name="jeTagLayout" value="${id}" ${conf.layout === id ? 'checked' : ''}>
                <span class="je-mth-tile-art" data-layout="${id}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
                <span class="je-mth-tile-name" data-je-label>${tx(JE.core.tagLayout.VOCABULARY_KEYS.layout[id])}</span>
            </label>`).join('');
        const density = ['full', 'compact'].map((id) => `
            <label class="je-mth-pill">
                <input type="radio" name="jeTagDensity" value="${id}" ${conf.density === id ? 'checked' : ''}>
                <span data-je-label>${tx(`panel_settings_ui_tag_density_${id}`)}</span>
            </label>`).join('');
        const edge = EDGES.map((id) => `
            <label class="je-mth-pill">
                <input type="radio" name="jeTagEdge" value="${id}" ${conf.edge === id ? 'checked' : ''}>
                <span data-je-label>${tx(JE.core.tagLayout.VOCABULARY_KEYS.edge[id])}</span>
            </label>`).join('');
        const native = JE.pluginConfig?.NativePosterTagsEnabled === true
            ? switchRow('nativePosterTagsToggle', JE.currentSettings.useNativePosterTags !== false, 'panel_settings_ui_native_poster_tags', 'panel_settings_ui_native_poster_tags_desc')
            : '';
        return `
            <section class="je-mth-card" aria-labelledby="jeMthLayoutTitle">
                <h4 class="je-mth-card-title" id="jeMthLayoutTitle">${tx('common_layout')}</h4>
                <p class="je-mth-hint">${tx('panel_media_tags_layout_desc')}</p>
                <div class="je-mth-tiles" id="jeTagLayoutChoice" role="radiogroup" aria-labelledby="jeMthLayoutTitle" aria-describedby="jeMthLayoutDesc">${tiles}</div>
                <p class="je-mth-desc" id="jeMthLayoutDesc" aria-live="polite">${tx(`panel_settings_ui_tag_layout_${conf.layout}`)}</p>
                <div class="je-mth-density">
                    <div class="je-mth-field-text">
                        <span class="je-mth-label" id="jeMthDensityLabel">${tx('panel_settings_ui_tag_density')}</span>
                        <span class="je-mth-hint" id="jeMthDensityDesc">${tx('panel_settings_ui_tag_density_desc')}</span>
                    </div>
                    <div class="je-mth-pills" id="jeTagDensityChoice" role="radiogroup" aria-labelledby="jeMthDensityLabel" aria-describedby="jeMthDensityDesc">${density}</div>
                </div>
                ${sizeControlHtml('scale', conf)}
                ${sizeControlHtml('gap', conf)}
                <div class="je-mth-density je-mth-edge">
                    <div class="je-mth-field-text">
                        <span class="je-mth-label" id="jeMthEdgeLabel">${tx('panel_settings_ui_tag_edge')}</span>
                        <span class="je-mth-hint" id="jeMthEdgeDesc">${tx('panel_settings_ui_tag_edge_desc')}</span>
                    </div>
                    <div class="je-mth-pills" id="jeTagEdgeChoice" role="radiogroup" aria-labelledby="jeMthEdgeLabel" aria-describedby="jeMthEdgeDesc">${edge}</div>
                </div>
            </section>
            <div class="je-mth-shapes">${shapesHtml()}</div>
            <p class="je-mth-hint je-mth-shapes-note">${tx('tag_shapes_limitations')}</p>
            <section class="je-mth-card" aria-labelledby="jeMthSwitchesTitle">
                <h4 class="je-mth-card-title" id="jeMthSwitchesTitle">${tx('panel_media_tags_switches_title')}</h4>
                <p class="je-mth-hint">${tx('panel_media_tags_switches_desc')}</p>
                <div class="je-mth-switches">
                    ${switchRow('tagsHideOnHoverToggle', !!JE.currentSettings.tagsHideOnHover, 'panel_settings_ui_hide_tags_on_hover', 'panel_settings_ui_hide_tags_on_hover_desc')}
                    ${native}
                    ${switchRow('peopleTagsToggle', !!JE.currentSettings.peopleTagsEnabled, 'panel_settings_ui_people_tags', 'panel_settings_ui_people_tags_desc')}
                </div>
            </section>
            ${internal.buildTagPortableHtml?.() || ''}`;
    }

    /**
     * A status chip as the status module draws it, for a badge card.
     * @param {string[]} chip - [kind, data-je-status, label key].
     * @returns {string}
     */
    function statusChipHtml([kind, status, labelKey, params]) {
        if (kind === 'trending') {
            const [before, after = ''] = JE.t(labelKey, { rank: '\u0001' }).split('\u0001');
            const hash = before.endsWith('#') ? '#' : '';
            return `<span class="status-tag status-tag--${kind}" data-je-status="${status}">${escapeHtml(before.slice(0, before.length - hash.length))}<span class="status-tag-rank">${hash}1</span>${escapeHtml(after)}</span>`;
        }
        return `<span class="status-tag status-tag--${kind}" data-je-status="${status}">${tx(labelKey, params)}</span>`;
    }

    /** @returns {string} The Status badges tab. */
    function badgesPanelHtml() {
        const admin = isAdmin();
        const rows = BADGE_FAMILIES.map((f) => {
            const days = Number(JE.pluginConfig?.[f.windowSetting]) || f.windowFallback;
            const window = f.windowKey ? `<span class="je-mth-badge-window">${tx(f.windowKey, { days })}</span>`
                : f.requires && JE.pluginConfig?.[f.requires] !== true ? `<span class="je-mth-badge-window">${tx(f.requiresKey)}</span>` : '';
            return `
                <div class="je-quality-cat-row je-mth-badge" data-cat-key="${f.key}">
                    <label class="je-mth-badge-main">
                        <input type="checkbox" id="${f.id}" ${effectiveBool(f.key, f.fallback) ? 'checked' : ''} aria-describedby="${f.id}Desc">
                        <span class="je-mth-badge-text">
                            <span class="je-mth-badge-name" data-je-label>${tx(f.nameKey)}</span>
                            <span class="je-mth-badge-desc" id="${f.id}Desc">${tx(f.descKey)}${window ? ' · ' : ''}${window}</span>
                        </span>
                    </label>
                    <span class="je-mth-badge-sample" aria-hidden="true">${statusChipHtml(f.chip)}</span>
                </div>`;
        }).join('');
        const adminLink = admin ? `
            <a class="je-mth-link" href="${escapeHtml(configUrl('badges'))}" data-je-config-link>${tx('panel_media_tags_badge_windows_admin')}<span class="material-icons" aria-hidden="true">open_in_new</span></a>` : '';
        return `
            <section class="je-mth-card" aria-labelledby="jeMthBadgesTitle">
                <h4 class="je-mth-card-title" id="jeMthBadgesTitle" tabindex="-1">${tx('panel_media_tags_tab_badges')}</h4>
                <p class="je-mth-hint">${tx('panel_media_tags_badges_desc')}</p>
                <div class="je-mth-off je-mth-off--action" id="jeMthBadgesOff" ${JE.currentSettings.statusTagsEnabled ? 'hidden' : ''}><span>${tx('panel_media_tags_badges_off')}</span>
                    <button type="button" class="je-mth-button" data-je-goto="groups:status">${tx('panel_media_tags_badges_turn_on')}<span class="material-icons" aria-hidden="true">arrow_forward</span></button></div>
                <div id="statusTagsSubToggles" class="je-mth-badges">${rows}</div>
                <div class="je-mth-actions">
                    <button type="button" class="je-mth-button" data-je-goto="groups:status">${tx('panel_media_tags_badges_to_groups')}<span class="material-icons" aria-hidden="true">arrow_forward</span></button>
                    ${adminLink}
                </div>
            </section>`;
    }

    /** @returns {string} The Rules & locks tab: the rules module renders into the mount. */
    function rulesPanelHtml() {
        return `
            <section class="je-mth-card" aria-labelledby="jeTagLooksTitle">
                <h4 class="je-mth-card-title" id="jeTagLooksTitle">${tx('panel_media_tags_tab_rules')}</h4>
                <p class="je-mth-hint">${tx('tag_looks_hub_desc')}</p>
                <div id="jeTagLooksMount"></div>
            </section>`;
    }

    /** @returns {string} The Colours tab: preset tiles while allowed, the editor pointer for admins. */
    function coloursPanelHtml() {
        const admin = isAdmin();
        let presets;
        if (presetsAllowed()) {
            const mine = PRESETS.includes(JE.currentSettings.tagStylePreset) ? JE.currentSettings.tagStylePreset : '';
            const server = PRESETS.includes(JE.pluginConfig.TagStylePreset) ? JE.pluginConfig.TagStylePreset : 'default';
            const tile = (value, name, sub = '') => `
                <label class="je-mth-preset">
                    <input type="radio" name="jeTagPreset" value="${value}" ${mine === value ? 'checked' : ''}>
                    <span class="je-mth-preset-chips" data-preset="${value || 'server'}" aria-hidden="true">
                        <span class="je-mth-chip" data-chip="quality">4K</span><span class="je-mth-chip" data-chip="status">${tx('status_tag_compact_added')}</span><span class="je-mth-chip" data-chip="rating">★ 8.1</span><span class="je-mth-chip je-mth-chip-genre" data-chip="genre" data-je-genre="${GENRE_SAMPLE}"><i class="je-mth-chip-glyph">${escapeHtml(JE.genreTags?.iconFor(GENRE_SAMPLE) || 'theater_comedy')}</i></span>
                    </span>
                    <span class="je-mth-preset-name" data-je-label>${escapeHtml(name)}</span>${sub ? `<span class="je-mth-preset-sub">${escapeHtml(sub)}</span>` : ''}
                </label>`;
            presets = `
                <div class="je-mth-presets" id="jeTagPresetChoice" role="radiogroup" aria-labelledby="jeMthColoursTitle" aria-describedby="jeMthColoursDesc">
                    ${tile('', JE.t('panel_settings_ui_tag_style_preset_follow'), JE.t('panel_settings_ui_tag_style_preset_server', { preset: JE.t(JE.core.tagLayout.VOCABULARY_KEYS.preset[server]) }))}
                    ${PRESETS.map((id) => tile(id, JE.t(JE.core.tagLayout.VOCABULARY_KEYS.preset[id]))).join('')}
                </div>`;
        } else {
            presets = `<p class="je-mth-off">${tx('panel_media_tags_colours_presets_off')}</p>`;
        }
        const editor = admin ? `
            <section class="je-mth-card je-mth-admin" aria-labelledby="jeMthColourEditorTitle">
                <div class="je-mth-pointer">
                    <div>
                        <h4 class="je-mth-card-title" id="jeMthColourEditorTitle">${tx('panel_media_tags_server_colours')} <span class="je-mth-admin-chip">${tx('common_admin')}</span></h4>
                        <p class="je-mth-hint">${tx('panel_media_tags_server_colours_desc')}</p>
                    </div>
                    <a class="je-mth-button" href="${escapeHtml(configUrl('colours'))}" data-je-config-link aria-label="${tx('panel_media_tags_open_named', { name: JE.t('panel_media_tags_server_colours') })}">${tx('common_open')}<span class="material-icons" aria-hidden="true">open_in_new</span></a>
                </div>
            </section>` : '';
        return `
            <section class="je-mth-card" aria-labelledby="jeMthColoursTitle">
                <h4 class="je-mth-card-title" id="jeMthColoursTitle">${tx('panel_settings_ui_tag_style_preset')}</h4>
                <p class="je-mth-hint" id="jeMthColoursDesc">${tx('panel_settings_ui_tag_style_preset_desc')}</p>
                ${presets}
            </section>
            ${editor}`;
    }

    /** @returns {string} The Server tab (admins only): one row per configuration page section. */
    function serverPanelHtml() {
        const rows = SERVER_LINKS.map((link) => `
            <li class="je-mth-pointer">
                <div>
                    <div class="je-mth-pointer-name" data-je-label>${tx(link.nameKey)}</div>
                    <div class="je-mth-hint">${tx(link.descKey)}</div>
                </div>
                <a class="je-mth-button" href="${escapeHtml(configUrl(link.tab))}" data-je-config-link aria-label="${tx('panel_media_tags_open_named', { name: JE.t(link.nameKey) })}">${tx('common_open')}<span class="material-icons" aria-hidden="true">open_in_new</span></a>
            </li>`).join('');
        return `
            <section class="je-mth-card je-mth-admin" aria-labelledby="jeMthServerTitle">
                <h4 class="je-mth-card-title" id="jeMthServerTitle">${tx('panel_media_tags_server_title')} <span class="je-mth-admin-chip">${tx('common_admin')}</span></h4>
                <p class="je-mth-hint">${tx('panel_media_tags_server_desc')}</p>
                <ul class="je-mth-pointers">${rows}</ul>
            </section>`;
    }

    /**
     * The whole Media Tags section for the panel template.
     * @param {Object} ctx - Panel context from ui-panel.js.
     * @returns {string}
     */
    internal.buildMediaTagsHubHtml = function(ctx) {
        const tabs = tabsFor();
        const content = {
            layout: layoutPanelHtml,
            groups: () => internal.buildTagGroupEditorHtml?.(ctx) || '',
            badges: badgesPanelHtml,
            rules: rulesPanelHtml,
            colours: coloursPanelHtml,
            server: serverPanelHtml,
        };
        const tabButtons = tabs.map((tab, i) => {
            const name = JE.t(tab.nameKey);
            const short = tab.shortKey ? JE.t(tab.shortKey) : name;
            // The accessible name always contains the visible (short) label.
            const label = tab.admin ? JE.t('panel_media_tags_tab_server_name', { name }) : name;
            return `<button type="button" role="tab" class="je-mth-tab${tab.admin ? ' je-mth-tab--admin' : ''}" id="jeMthTab-${tab.id}" data-tab="${tab.id}" aria-controls="jeMthPanel-${tab.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" aria-label="${escapeHtml(label)}">`
                + `<span class="je-mth-tab-long">${escapeHtml(name)}</span><span class="je-mth-tab-short" aria-hidden="true">${escapeHtml(short)}</span>`
                + (tab.admin ? `<span class="je-mth-admin-chip" aria-hidden="true">${tx('common_admin')}</span>` : '')
                + '</button>';
        }).join('');
        const panels = tabs.map((tab, i) => `
            <div class="je-mth-panel" role="tabpanel" id="jeMthPanel-${tab.id}" data-tab="${tab.id}" aria-labelledby="jeMthTab-${tab.id}" ${i === 0 ? '' : 'hidden'}>${content[tab.id]()}</div>`).join('');
        return `
            <section class="je-pane" data-pane="media-tags">
                <div class="je-mth" id="jeMediaTagsHub" data-tab="${tabs[0].id}">
                    <div class="je-mth-top">
                        <h3 class="je-pane-title">${JE.icon(JE.IconName.TAG)} ${tx('common_media_tags')}</h3>
                        <div class="je-mth-tabs" role="tablist" aria-label="${tx('common_media_tags')}">${tabButtons}</div>
                        <span class="je-mth-autosave"><span class="material-icons" aria-hidden="true">cloud_done</span>${tx('panel_media_tags_autosave')}</span>
                    </div>
                    <div class="je-mth-strip" id="jeMthStrip">
                        <button type="button" class="je-mth-strip-toggle" id="jeMthStripToggle" aria-expanded="false" aria-controls="jeMthPreview">${tx('common_preview')}<span class="material-icons" aria-hidden="true">expand_more</span></button>
                        <div class="je-mth-strip-thumb" aria-hidden="true"></div>
                        <div class="je-mth-strip-info">
                            <div class="je-mth-strip-text"></div>
                            <div class="je-mth-strip-chips"></div>
                        </div>
                    </div>
                    <div class="je-mth-body">
                        <aside class="je-mth-preview" id="jeMthPreview" aria-label="${tx('panel_media_tags_preview')}"></aside>
                        <div class="je-mth-panels">${panels}</div>
                    </div>
                    <div class="je-mth-live" id="jeMthLive" role="status" aria-live="polite"></div>
                </div>
            </section>`;
    };

    /** The hub's stylesheet (panel-scoped). */
    const HUB_CSS = `
        #jellyfin-enhanced-panel .je-mth { container: je-mth / inline-size; padding-bottom: 8px; --je-mth-sel: color-mix(in srgb, var(--je-mth-accent) 72%, #000); }
        #jellyfin-enhanced-panel .je-mth-top { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0 20px; border-bottom: 1px solid rgba(255,255,255,0.12); margin-bottom: 12px; }
        #jellyfin-enhanced-panel .je-mth-top .je-pane-title { margin: 14px 0 10px; }
        #jellyfin-enhanced-panel .je-mth-tabs { display: flex; gap: 2px; min-width: 0; }
        #jellyfin-enhanced-panel .je-mth-tab { position: relative; display: inline-flex; align-items: center; gap: 6px; padding: 10px 10px 11px; min-height: 40px; background: transparent; border: 0; color: rgba(255,255,255,0.72); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; border-radius: 6px 6px 0 0; }
        #jellyfin-enhanced-panel .je-mth-tab:hover { color: #fff; background: rgba(255,255,255,0.05); }
        #jellyfin-enhanced-panel .je-mth-tab[aria-selected="true"] { color: var(--je-mth-accent); }
        #jellyfin-enhanced-panel .je-mth-tab[aria-selected="true"]::after { content: ''; position: absolute; left: 6px; right: 6px; bottom: -1px; height: 3px; border-radius: 3px; background: var(--je-mth-accent); }
        #jellyfin-enhanced-panel .je-mth-tab:focus-visible { outline: 2px solid #fff; outline-offset: -2px; }
        #jellyfin-enhanced-panel .je-mth-tab-short { display: none; }
        #jellyfin-enhanced-panel .je-mth-autosave { display: inline-flex; align-items: center; gap: 4px; margin: 0 0 12px auto; font-size: 12px; color: rgba(255,255,255,0.62); white-space: nowrap; }
        #jellyfin-enhanced-panel .je-mth-autosave .material-icons { font-size: 16px; }
        #jellyfin-enhanced-panel .je-mth-tab--admin[aria-selected="true"] { color: #ffb74d; }
        #jellyfin-enhanced-panel .je-mth-tab--admin[aria-selected="true"]::after { background: #ffb74d; }
        #jellyfin-enhanced-panel .je-mth-admin-chip { display: inline-block; padding: 1px 5px; border: 1px solid #ffb74d; border-radius: 4px; color: #ffb74d; font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; vertical-align: middle; }
        #jellyfin-enhanced-panel .je-mth-body { display: grid; grid-template-columns: minmax(0, 1fr) clamp(288px, 30cqi, 400px); gap: 16px; align-items: start; }
        #jellyfin-enhanced-panel .je-mth-panels { grid-column: 1; grid-row: 1; min-width: 0; container: je-mth-panels / inline-size; }
        #jellyfin-enhanced-panel .je-mth-preview { grid-column: 2; grid-row: 1; position: sticky; top: 8px; padding: 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.03); }
        #jellyfin-enhanced-panel .je-mth[data-tab="server"] .je-mth-body { grid-template-columns: minmax(0, 1fr); }
        #jellyfin-enhanced-panel .je-mth[data-tab="server"] :is(.je-mth-preview, .je-mth-strip) { display: none !important; }
        #jellyfin-enhanced-panel .je-mth-panel[hidden] { display: none; }
        #jellyfin-enhanced-panel .je-mth-card { margin: 0 0 12px; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.1); background: var(--je-mth-box); }
        #jellyfin-enhanced-panel .je-mth-card .je-tge { margin: 0; padding: 0; background: none; border: 0; }
        #jellyfin-enhanced-panel .je-mth-card-title { margin: 0 0 4px; font-size: 16px; font-weight: 600; color: #fff; }
        #jellyfin-enhanced-panel .je-mth-card-title:focus { outline: none; }
        #jellyfin-enhanced-panel .je-mth-card-title:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        #jellyfin-enhanced-panel .je-mth-hint { margin: 0 0 8px; font-size: 13px; line-height: 1.45; color: rgba(255,255,255,0.68); }
        #jellyfin-enhanced-panel .je-mth-desc { margin: 8px 0 4px; font-size: 13px; color: rgba(255,255,255,0.85); }
        #jellyfin-enhanced-panel .je-mth-label { font-size: 14px; font-weight: 600; }
        #jellyfin-enhanced-panel .je-mth-off { margin: 4px 0 10px; padding: 8px 10px; border-radius: 6px; background: rgba(255,183,77,0.12); color: #ffd699; font-size: 12px; }
        #jellyfin-enhanced-panel .je-mth-off[hidden] { display: none; }
        #jellyfin-enhanced-panel .je-mth-off--action { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; font-size: 13px; }
        #jellyfin-enhanced-panel .je-mth-off--action .je-mth-button { min-height: 40px; }
        #jellyfin-enhanced-panel .je-mth-off--action[hidden] { display: none; }
        #jellyfin-enhanced-panel .je-mth input[type="radio"] { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; pointer-events: none; }
        #jellyfin-enhanced-panel .je-mth-tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin-top: 6px; }
        #jellyfin-enhanced-panel .je-mth-tile { position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 4px 8px; min-height: 40px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.2); cursor: pointer; text-align: center; }
        #jellyfin-enhanced-panel .je-mth-tile:hover { background: rgba(255,255,255,0.06); }
        #jellyfin-enhanced-panel .je-mth-tile:has(input:checked) { border: 2px solid var(--je-mth-accent); padding: 9px 3px 7px; background: color-mix(in srgb, var(--je-mth-accent) 16%, transparent); }
        #jellyfin-enhanced-panel :is(.je-mth-tile, .je-mth-pill, .je-mth-preset):has(input:focus-visible) { outline: 2px solid #fff; outline-offset: 2px; }
        #jellyfin-enhanced-panel .je-mth-tile-name { font-size: 13px; font-weight: 600; line-height: 1.2; }
        #jellyfin-enhanced-panel .je-mth-tile-art { position: relative; width: 26px; height: 38px; border-radius: 3px; background: #4a5160; }
        #jellyfin-enhanced-panel .je-mth-tile-art i { position: absolute; display: none; height: 4px; border-radius: 1px; }
        #jellyfin-enhanced-panel [data-layout="corners"] i { display: block; width: 8px; }
        #jellyfin-enhanced-panel [data-layout="corners"] i:nth-child(1) { left: 2px; top: 2px; background: #42a5f5; }
        #jellyfin-enhanced-panel [data-layout="corners"] i:nth-child(2) { right: 2px; top: 2px; background: #ef5350; }
        #jellyfin-enhanced-panel [data-layout="corners"] i:nth-child(3) { left: 2px; bottom: 2px; background: #ab47bc; }
        #jellyfin-enhanced-panel [data-layout="corners"] i:nth-child(4) { right: 2px; bottom: 2px; background: #ffca28; }
        #jellyfin-enhanced-panel [data-layout="bands"] { width: 30px; height: 30px; margin: 4px 0; }
        #jellyfin-enhanced-panel [data-layout="bands"] i:nth-child(-n+4) { display: block; width: 7px; }
        #jellyfin-enhanced-panel [data-layout="bands"] i:nth-child(1) { left: 2px; top: -6px; background: #ef5350; }
        #jellyfin-enhanced-panel [data-layout="bands"] i:nth-child(2) { left: 10px; top: -6px; background: #42a5f5; }
        #jellyfin-enhanced-panel [data-layout="bands"] i:nth-child(3) { left: 2px; bottom: -6px; background: #ffca28; }
        #jellyfin-enhanced-panel [data-layout="bands"] i:nth-child(4) { left: 10px; bottom: -6px; background: #66bb6a; }
        #jellyfin-enhanced-panel [data-layout="caption"] { height: 32px; margin-bottom: 6px; }
        #jellyfin-enhanced-panel [data-layout="caption"] i:nth-child(1) { display: block; right: 2px; top: 2px; width: 8px; background: #ef5350; }
        #jellyfin-enhanced-panel [data-layout="caption"] i:nth-child(2) { display: block; left: 0; bottom: -7px; width: 8px; background: #42a5f5; }
        #jellyfin-enhanced-panel [data-layout="caption"] i:nth-child(3) { display: block; left: 9px; bottom: -7px; width: 8px; background: #ffca28; }
        #jellyfin-enhanced-panel [data-layout="caption"] i:nth-child(4) { display: block; left: 18px; bottom: -7px; width: 8px; background: #66bb6a; }
        #jellyfin-enhanced-panel [data-layout="summary"] i:nth-child(1) { display: block; left: 4px; right: 4px; bottom: 4px; height: 6px; border-radius: 3px; background: #111; box-shadow: inset 0 0 0 1px #ffca28; }
        #jellyfin-enhanced-panel [data-layout="minimal"] i:nth-child(1) { display: block; right: 2px; top: 2px; width: 8px; background: #ef5350; }
        #jellyfin-enhanced-panel [data-layout="minimal"] i:nth-child(2) { display: block; left: 3px; bottom: 3px; width: 4px; height: 4px; border-radius: 50%; background: #42a5f5; }
        #jellyfin-enhanced-panel [data-layout="minimal"] i:nth-child(3) { display: block; left: 9px; bottom: 3px; width: 4px; height: 4px; border-radius: 50%; background: #66bb6a; }
        #jellyfin-enhanced-panel .je-mth-shape-toggle { display: flex; align-items: center; gap: 10px; min-height: 40px; font-size: 14px; cursor: pointer; }
        #jellyfin-enhanced-panel .je-mth-shape-toggle input { width: 18px; height: 18px; margin: 0; accent-color: var(--je-mth-accent); }
        #jellyfin-enhanced-panel .je-mth-shape-more { margin-top: 6px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; }
        #jellyfin-enhanced-panel .je-mth-shape-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; padding: 0 10px 0 12px; list-style: none; cursor: pointer; border-radius: 8px; }
        #jellyfin-enhanced-panel .je-mth-shape-summary::-webkit-details-marker { display: none; }
        #jellyfin-enhanced-panel .je-mth-shape-summary:hover { background: rgba(255,255,255,0.05); }
        #jellyfin-enhanced-panel .je-mth-shape-summary:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        #jellyfin-enhanced-panel .je-mth-shape-summary-text { font-size: 14px; font-weight: 600; }
        #jellyfin-enhanced-panel .je-mth-shape-summary-action { display: inline-flex; align-items: center; gap: 2px; font-size: 13px; color: rgba(255,255,255,0.75); }
        #jellyfin-enhanced-panel .je-mth-shape-summary-action .material-icons { font-size: 20px; transition: transform 0.2s ease; }
        #jellyfin-enhanced-panel .je-mth-shape-more[open] .je-mth-shape-summary-action .material-icons { transform: rotate(180deg); }
        #jellyfin-enhanced-panel .je-mth-shape-more > :not(summary) { margin-left: 12px; margin-right: 12px; }
        #jellyfin-enhanced-panel .je-mth-shape-more[open] > summary { border-bottom: 1px solid rgba(255,255,255,0.08); border-radius: 8px 8px 0 0; }
        #jellyfin-enhanced-panel .je-mth-shapes-note { margin: -2px 2px 12px; }
        #jellyfin-enhanced-panel .je-mth-shape-fields { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; margin: 8px 0; }
        #jellyfin-enhanced-panel .je-mth-shape-fields label { display: flex; flex-direction: column; gap: 4px; flex: 1 1 120px; font-size: 12px; }
        #jellyfin-enhanced-panel .je-mth-shape-fields select { min-height: 36px; width: 100%; border: 1px solid #666; border-radius: 5px; background: #20242b; color: #fff; font: inherit; padding: 4px; }
        #jellyfin-enhanced-panel .je-mth-shape-group { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 8px 0; border-top: 1px solid rgba(255,255,255,0.1); }
        #jellyfin-enhanced-panel .je-mth-shape-group > .je-mth-label { flex: 1 0 100%; }
        #jellyfin-enhanced-panel .je-mth-shape-positions { display: flex; flex-wrap: wrap; gap: 4px; flex: 1 1 180px; }
        #jellyfin-enhanced-panel .je-mth-shape :is(button, input):focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        #jellyfin-enhanced-panel .je-mth-shape-positions button, #jellyfin-enhanced-panel .je-mth-shape-cap button { min-height: 32px; padding: 3px 8px; background: rgba(255,255,255,0.06); color: #fff; border: 1px solid #666; border-radius: 16px; font: inherit; font-size: 12px; cursor: pointer; }
        #jellyfin-enhanced-panel .je-mth-shape-positions [aria-pressed="true"] { background: var(--je-mth-sel); border-color: var(--je-mth-sel); font-weight: 600; }
        #jellyfin-enhanced-panel .je-mth-shape-cap { display: flex; align-items: center; gap: 6px; font-size: 12px; }
        #jellyfin-enhanced-panel .je-mth-shape-cap output { min-width: 24px; text-align: center; }
        #jellyfin-enhanced-panel .je-mth-shape-cap button:disabled { opacity: 0.35; cursor: default; }
        /* A field row: label and its help on the left, the choice on the right (below on a narrow pane). */
        #jellyfin-enhanced-panel .je-mth-density { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 12px 0; border-top: 1px solid rgba(255,255,255,0.08); }
        #jellyfin-enhanced-panel .je-mth-desc + .je-mth-density { margin-top: 8px; }
        #jellyfin-enhanced-panel .je-mth-density:last-child { padding-bottom: 2px; }
        #jellyfin-enhanced-panel .je-mth-field-text { display: flex; flex-direction: column; gap: 2px; flex: 1 1 240px; min-width: 0; }
        #jellyfin-enhanced-panel .je-mth-field-text .je-mth-hint { margin: 0; }
        #jellyfin-enhanced-panel .je-mth-density > .je-mth-pills { margin-left: auto; }
        #jellyfin-enhanced-panel .je-mth-pills { display: inline-flex; flex-wrap: wrap; gap: 6px; }
        #jellyfin-enhanced-panel .je-mth-pill { position: relative; display: inline-flex; align-items: center; min-height: 36px; padding: 0 16px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.25); font-size: 13px; cursor: pointer; }
        #jellyfin-enhanced-panel .je-mth-pill:hover { background: rgba(255,255,255,0.06); }
        #jellyfin-enhanced-panel .je-mth-pill:has(input:checked) { background: var(--je-mth-sel); border-color: var(--je-mth-sel); color: #fff; font-weight: 600; }
        #jellyfin-enhanced-panel .je-mth-switches { border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; overflow: hidden; }
        #jellyfin-enhanced-panel .je-mth-switch { display: flex; align-items: flex-start; gap: 12px; padding: 8px 12px; min-height: 40px; box-sizing: border-box; cursor: pointer; }
        #jellyfin-enhanced-panel .je-mth-switch + .je-mth-switch { border-top: 1px solid rgba(255,255,255,0.08); }
        #jellyfin-enhanced-panel .je-mth-switch input { width: 18px; height: 18px; margin: 2px 0 0; flex-shrink: 0; accent-color: var(--je-mth-accent); cursor: pointer; }
        #jellyfin-enhanced-panel .je-mth-switch-text, #jellyfin-enhanced-panel .je-mth-badge-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
        #jellyfin-enhanced-panel .je-mth-switch-name, #jellyfin-enhanced-panel .je-mth-badge-name { font-size: 14px; font-weight: 500; }
        #jellyfin-enhanced-panel .je-mth-switch-desc, #jellyfin-enhanced-panel .je-mth-badge-desc { font-size: 13px; color: rgba(255,255,255,0.66); line-height: 1.4; }
        #jellyfin-enhanced-panel .je-mth-switch-desc { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
        #jellyfin-enhanced-panel .je-mth-switch:focus-within .je-mth-switch-desc, #jellyfin-enhanced-panel .je-mth-switch:hover .je-mth-switch-desc { -webkit-line-clamp: unset; }
        #jellyfin-enhanced-panel .je-mth-badges { display: flex; flex-direction: column; gap: 6px; }
        #jellyfin-enhanced-panel .je-mth-badge { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.18); }
        #jellyfin-enhanced-panel .je-mth-badge-main { display: flex; align-items: flex-start; gap: 12px; min-width: 0; cursor: pointer; flex: 1; }
        #jellyfin-enhanced-panel .je-mth-badge-main input { width: 18px; height: 18px; margin: 2px 0 0; flex-shrink: 0; accent-color: var(--je-mth-accent); cursor: pointer; }
        #jellyfin-enhanced-panel .je-mth-badge-window { white-space: nowrap; }
        /* Not a .status-overlay-container: the status module removes every one of those when it re-initialises. */
        #jellyfin-enhanced-panel .je-mth-badge-sample { display: inline-flex; flex-shrink: 0; max-width: 45%; }
        #jellyfin-enhanced-panel .je-mth-badge:not(:has(input:checked)) .je-mth-badge-sample { opacity: 0.35; filter: grayscale(1); }
        #jellyfin-enhanced-panel .je-mth-actions { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin-top: 10px; }
        #jellyfin-enhanced-panel .je-mth-button { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.22); background: rgba(255,255,255,0.06); color: #fff; font: inherit; font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer; white-space: nowrap; }
        #jellyfin-enhanced-panel .je-mth-button:hover { background: rgba(255,255,255,0.12); }
        #jellyfin-enhanced-panel :is(.je-mth-button, .je-mth-link, .je-mth-strip-toggle):focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        #jellyfin-enhanced-panel .je-mth-button .material-icons, #jellyfin-enhanced-panel .je-mth-link .material-icons { font-size: 16px; }
        #jellyfin-enhanced-panel .je-mth-link { display: inline-flex; align-items: center; gap: 4px; min-height: 36px; color: #7fd3ff; font-size: 13px; }
        #jellyfin-enhanced-panel .je-mth-presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; margin-top: 6px; }
        #jellyfin-enhanced-panel .je-mth-preset { position: relative; display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.25); cursor: pointer; }
        #jellyfin-enhanced-panel .je-mth-preset:has(input:checked) { border: 2px solid var(--je-mth-accent); padding: 9px; }
        #jellyfin-enhanced-panel .je-mth-preset-chips { display: flex; flex-wrap: wrap; gap: 3px; min-height: 22px; padding: 6px 5px; border-radius: 4px; background: linear-gradient(135deg, #39424f, #1b1f26); overflow: hidden; }
        #jellyfin-enhanced-panel .je-mth-chip { display: inline-flex; align-items: center; padding: 2px 4px; border-radius: 4px; border: 1px solid transparent; font-size: 10px; font-weight: 700; line-height: 1.2; white-space: nowrap; }
        /* The genre circle sits at the right, as on a poster; in a narrow tile it takes a row of its own. */
        #jellyfin-enhanced-panel .je-mth-chip-genre { justify-content: center; flex-shrink: 0; width: 18px; height: 18px; margin-left: auto; padding: 0; border-radius: 50%; box-sizing: border-box; }
        #jellyfin-enhanced-panel .je-mth-chip-glyph { font-family: 'JE Material Symbols Outlined'; font-style: normal; font-weight: normal; font-size: 12px; line-height: 1; letter-spacing: normal; text-transform: none; direction: ltr; font-feature-settings: 'liga'; -webkit-font-smoothing: antialiased; }
        #jellyfin-enhanced-panel .je-mth-preset-name { font-size: 13px; font-weight: 600; }
        #jellyfin-enhanced-panel .je-mth-preset-sub { margin-top: -6px; font-size: 12px; color: rgba(255,255,255,0.68); }
        #jellyfin-enhanced-panel .je-mth-admin { background: rgba(255,183,77,0.05); border-color: rgba(255,183,77,0.25); }
        #jellyfin-enhanced-panel .je-mth-pointers { list-style: none; margin: 0; padding: 0; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; }
        #jellyfin-enhanced-panel .je-mth-pointer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        #jellyfin-enhanced-panel .je-mth-pointers .je-mth-pointer { padding: 10px 12px; }
        #jellyfin-enhanced-panel .je-mth-pointers .je-mth-pointer + .je-mth-pointer { border-top: 1px solid rgba(255,255,255,0.08); }
        #jellyfin-enhanced-panel .je-mth-pointer .je-mth-hint { margin: 2px 0 0; }
        #jellyfin-enhanced-panel .je-mth-pointer-name { font-size: 14px; font-weight: 600; }
        #jellyfin-enhanced-panel .je-mth-strip { display: none; }
        /* The strip thumbnail: one mark per group where the followed sample shows it. */
        #jellyfin-enhanced-panel .je-mth-strip-thumb i { position: absolute; width: 8px; height: 4px; border-radius: 1px; background: #ccc; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-group="status"] { background: #ef5350; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-group="quality"] { background: #42a5f5; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-group="rating"] { background: #ffca28; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-group="ageRating"] { background: #ab47bc; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-group="language"] { background: #66bb6a; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-group="genre"] { background: #26a69a; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-group="custom"] { background: #90a4ae; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i:is([data-slot="tl"], [data-slot="top"]) { left: 2px; top: calc(2px + var(--je-mtp-n) * 5px); }
        #jellyfin-enhanced-panel .je-mth-strip-thumb[data-layout="bands"] i[data-slot="top"] { left: calc(2px + var(--je-mtp-n) * 9px); top: 2px; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb[data-layout="minimal"] i[data-slot="top"], #jellyfin-enhanced-panel .je-mth-strip-thumb i:is([data-slot="tr"], [data-slot="poster"]) { left: auto; right: 2px; top: calc(2px + var(--je-mtp-n) * 5px); }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-slot="bl"] { left: 2px; bottom: calc(2px + var(--je-mtp-n) * 5px); }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i:is([data-slot="br"], [data-slot="corner"]) { right: 2px; bottom: calc(2px + var(--je-mtp-n) * 5px); }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-slot="bottom"] { left: calc(2px + var(--je-mtp-n) * 9px); bottom: 2px; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-slot="caption"] { left: calc(var(--je-mtp-n) * 9px); bottom: -6px; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-slot="pill"] { left: calc(50% - 7px + (var(--je-mtp-n) - 1) * 4px); bottom: 3px; width: 6px; height: 6px; border-radius: 3px; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-slot="dots"] { left: 3px; bottom: 3px; width: 4px; height: 4px; border-radius: 50%; }
        /* Keyboard focus never lands under the rule form's sticky Add rule bar. */
        #jellyfin-enhanced-panel .je-panel-main:has(.je-mth[data-tab="rules"]) { scroll-padding-bottom: 72px; }
        #jellyfin-enhanced-panel .je-mth-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
        /* Narrow pane (phone, or a small window): one column, the preview
           collapses into a one-line strip under the tabs that expands on tap. */
        /* Phone: the panel's Back button sits on the Media Tags title row instead of a row of its own. */
        @media (max-width: 760px) {
            #jellyfin-enhanced-panel .je-panel-main:has(.je-pane.active[data-pane="media-tags"], .je-pane[data-pane="media-tags"].active) > .je-pane-back { position: absolute; top: 6px; left: 14px; z-index: 4; width: 40px; height: 40px; margin: 0; }
            #jellyfin-enhanced-panel .je-pane[data-pane="media-tags"] .je-mth-top .je-pane-title { min-height: 44px; margin: 2px 0 4px 50px; }
        }
        @container je-mth (max-width: 679px) {
            #jellyfin-enhanced-panel .je-mth-top { gap: 0; }
            #jellyfin-enhanced-panel .je-mth-top .je-pane-title { margin: 2px 0 8px; font-size: 16px; }
            #jellyfin-enhanced-panel .je-mth-tabs { flex: 1 1 100%; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 2px; }
            #jellyfin-enhanced-panel .je-mth-tab { justify-content: center; min-height: 44px; padding: 8px 2px 9px; font-size: 13px; min-width: 0; }
            #jellyfin-enhanced-panel .je-mth-tab-long, #jellyfin-enhanced-panel .je-mth-tab .je-mth-admin-chip { display: none; }
            #jellyfin-enhanced-panel .je-mth-tab-short { display: inline; overflow: hidden; text-overflow: ellipsis; }
            #jellyfin-enhanced-panel .je-mth-tab--admin { color: #ffb74d; }
            #jellyfin-enhanced-panel .je-mth-body { grid-template-columns: minmax(0, 1fr); gap: 10px; }
            #jellyfin-enhanced-panel .je-mth-preview { grid-column: 1; grid-row: auto; position: static; display: none; }
            #jellyfin-enhanced-panel .je-mth-panels { grid-row: auto; }
            #jellyfin-enhanced-panel .je-mth.je-mth-strip-open .je-mth-preview { display: block; }
            #jellyfin-enhanced-panel .je-mth-strip { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 10px; margin: 0 0 10px; padding: 4px 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: rgb(28, 28, 28); }
            #jellyfin-enhanced-panel .je-mth-strip-toggle { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; min-height: 40px; padding: 0 8px 0 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.22); background: rgba(255,255,255,0.06); color: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
            #jellyfin-enhanced-panel .je-mth-strip-toggle[aria-expanded="true"] .material-icons { transform: rotate(180deg); }
            #jellyfin-enhanced-panel .je-mth-strip-thumb { position: relative; flex-shrink: 0; width: 28px; height: 42px; border-radius: 3px; background: #4a5160; }
            #jellyfin-enhanced-panel .je-mth-strip-thumb[data-shape="thumb"] { width: 48px; height: 27px; }
            #jellyfin-enhanced-panel .je-mth-strip-info { min-width: 0; flex: 1; font-size: 12px; line-height: 1.35; }
            #jellyfin-enhanced-panel .je-mth-strip-text { color: #fff; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            #jellyfin-enhanced-panel .je-mth-strip-chips { color: rgba(255,255,255,0.75); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            #jellyfin-enhanced-panel .je-mth-tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
            #jellyfin-enhanced-panel .je-mth-tile { padding: 8px 2px 6px; }
            #jellyfin-enhanced-panel .je-mth-tile-name { font-size: 13px; }
            #jellyfin-enhanced-panel .je-mtp-view button { min-height: 44px; }
            #jellyfin-enhanced-panel .je-mth-switch-desc { -webkit-line-clamp: 3; }
            #jellyfin-enhanced-panel .je-mth-presets { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            #jellyfin-enhanced-panel .je-mth-pill, #jellyfin-enhanced-panel .je-mth-button { min-height: 40px; }
            #jellyfin-enhanced-panel .je-mth-density > .je-mth-pills { margin-left: 0; }
            #jellyfin-enhanced-panel .je-mth-pointer { flex-wrap: wrap; }
            #jellyfin-enhanced-panel .je-mth-badge { position: relative; display: block; }
            #jellyfin-enhanced-panel .je-mth-badge-sample { position: absolute; top: 10px; right: 12px; max-width: 40%; }
            #jellyfin-enhanced-panel .je-mth-badge-name { display: block; min-height: 22px; padding-right: 40%; }
            #jellyfin-enhanced-panel .je-mth-autosave { order: 1; flex: 1 1 100%; margin: 0 0 8px; color: rgba(255,255,255,0.7); }
            #jellyfin-enhanced-panel .je-mth-tabs { order: 2; }
        }
    `;

    // ── Wiring ─────────────────────────────────────────────────────────

    /**
     * The visible label of a hub control, for the settings search: its
     * aria-label, the [data-je-label] part of its own label (a tile's or a
     * switch's name, not its description), its aria-labelledby text, or its text.
     * @param {HTMLElement} el
     * @returns {string}
     */
    function controlLabel(el) {
        const text = (node) => (node?.textContent || '').replace(/\s+/g, ' ').trim();
        const own = el.getAttribute('aria-label');
        if (own) return own.trim();
        const named = el.querySelector?.('[data-je-label]');
        if (named) return text(named);
        const label = /** @type {HTMLInputElement} */ (el).labels?.[0];
        if (label) return text(label.querySelector('[data-je-label]') || label);
        const by = el.getAttribute('aria-labelledby');
        if (by) return by.split(/\s+/).map((id) => text(document.getElementById(id))).join(' ').trim();
        return text(el);
    }

    /**
     * Wire the hub: tabs, layout and density tiles, the preview (built the
     * first time the section shows), the phone strip, search and the
     * pointers to the configuration page. Torn down when the panel closes.
     * @param {Object} ctx - Panel context ({ help, resetAutoCloseTimer, onClose, registerSearch, closePanel }).
     */
    internal.wireMediaTagsHub = function(ctx) {
        internal.mediaTagsHub?.dispose?.();
        const hub = /** @type {HTMLElement|null} */ (document.getElementById('jeMediaTagsHub'));
        if (!hub) return;
        JE.core.ui?.injectCss?.('je-media-tags-hub', HUB_CSS);
        hub.style.setProperty('--je-mth-accent', ctx.toggleAccentColor || '#00a4dc');
        hub.style.setProperty('--je-mth-box', ctx.presetBoxBackground || 'rgba(255,255,255,0.04)');
        const touch = () => { try { ctx.resetAutoCloseTimer?.(); } catch { /* panel closing */ } };
        const tablist = /** @type {HTMLElement} */ (hub.querySelector('[role="tablist"]'));
        const tabs = /** @type {HTMLElement[]} */ (Array.from(hub.querySelectorAll('[role="tab"]')));
        const live = /** @type {HTMLElement} */ (hub.querySelector('#jeMthLive'));
        const stripToggle = /** @type {HTMLElement|null} */ (hub.querySelector('#jeMthStripToggle'));
        const storeKey = `${TAB_STORE_PREFIX}${(typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId?.()) || ''}`;
        let disposed = false;
        /** @type {ReturnType<typeof internal.createTagPreview>|null} */
        let preview = null;
        /** @type {IntersectionObserver|null} */
        let io = null;
        let presetsLoaded = false;
        const cleanups = [];

        /** @param {string} message - Said by screen readers (polite). */
        const announce = (message) => {
            live.textContent = '';
            // A fresh node each time, so the same message twice is announced twice.
            setTimeout(() => { if (!disposed) live.textContent = message; }, 30);
        };

        /** @returns {string} The tab shown now. */
        const current = () => hub.dataset.tab || 'layout';

        /** Spotlight and strip sample for what is being edited on the current tab. */
        const syncFocusOfPreview = () => {
            if (!preview) return;
            const tab = current();
            let spot = null;
            if (tab === 'badges') spot = 'status';
            else if (tab === 'groups') {
                const open = hub.querySelector('.je-tge-row .je-tge-expand[aria-expanded="true"]');
                spot = /** @type {HTMLElement|null} */ (open?.closest('.je-tge-row'))?.dataset.group || null;
            }
            preview.setSpotlight(spot);
            preview.follow(tab === 'rules' ? 'episode' : 'movie');
        };

        /**
         * Show a tab.
         * @param {string} id
         * @param {{focusTab?: boolean, focus?: boolean}} [opts] - focusTab moves
         *   focus to the tab; focus moves it to the panel's heading.
         * @returns {boolean} False when this user has no such tab.
         */
        const select = (id, opts = {}) => {
            const tab = tabs.find((t) => t.dataset.tab === id);
            if (!tab) return false;
            for (const t of tabs) {
                const on = t === tab;
                t.setAttribute('aria-selected', String(on));
                t.tabIndex = on ? 0 : -1;
                const panel = document.getElementById(`jeMthPanel-${t.dataset.tab}`);
                if (panel) panel.hidden = !on;
            }
            hub.dataset.tab = id;
            try { window.localStorage.setItem(storeKey, id); } catch { /* storage unavailable */ }
            if (id === 'rules') internal.tagLooksPanel?.show?.();
            if (id === 'colours') loadPresetChips();
            syncFocusOfPreview();
            if (opts.focusTab) tab.focus();
            if (opts.focus) {
                const heading = /** @type {HTMLElement|null} */ (document.getElementById(`jeMthPanel-${id}`)?.querySelector('.je-mth-card-title, .je-tge-title'));
                if (heading) {
                    heading.tabIndex = -1;
                    heading.focus();
                }
            }
            touch();
            return true;
        };

        tablist.addEventListener('click', (e) => {
            const tab = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[role="tab"]'));
            if (tab) select(tab.dataset.tab || 'layout');
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
            select(tabs[next].dataset.tab || 'layout', { focusTab: true });
        });

        // ── Layout tiles and density ──
        const layoutDesc = hub.querySelector('#jeMthLayoutDesc');
        /** Keep the tiles, the description and the density pills on the effective settings. */
        const syncLayoutChoice = () => {
            if (disposed) return;
            const conf = layoutConf();
            hub.querySelectorAll('input[name="jeTagLayout"]').forEach((r) => { /** @type {HTMLInputElement} */ (r).checked = /** @type {HTMLInputElement} */ (r).value === conf.layout; });
            hub.querySelectorAll('input[name="jeTagDensity"]').forEach((r) => { /** @type {HTMLInputElement} */ (r).checked = /** @type {HTMLInputElement} */ (r).value === conf.density; });
            for (const name of ['Scale', 'Gap']) {
                hub.querySelectorAll(`input[name="jeTag${name}"]`).forEach(r => { r.checked = r.value === conf[`tag${name}`]; });
            }
            hub.querySelectorAll('input[name="jeTagEdge"]').forEach((r) => { /** @type {HTMLInputElement} */ (r).checked = /** @type {HTMLInputElement} */ (r).value === conf.edge; });
            if (layoutDesc) layoutDesc.textContent = JE.t(`panel_settings_ui_tag_layout_${conf.layout}`);
            const off = hub.querySelector('#jeMthBadgesOff');
            if (off) /** @type {HTMLElement} */ (off).hidden = !!JE.currentSettings?.statusTagsEnabled;
        };
        document.addEventListener('je:tag-layout-changed', syncLayoutChoice);
        cleanups.push(() => document.removeEventListener('je:tag-layout-changed', syncLayoutChoice));

        // Shape controls save only their own block. Keep an explicit all-off
        // object: null would inherit the administrator's overrides again.
        const shapeMount = hub.querySelector('.je-mth-shapes');
        /** Redraw shape controls after a default layout change or a reset. */
        const syncShapes = () => {
            if (disposed || !shapeMount) return;
            const active = document.activeElement;
            const row = active?.closest('.je-mth-shape');
            const focus = row ? { shape: row.dataset.shape, action: active.dataset.shapeAction, group: active.closest('[data-shape-group]')?.dataset.shapeGroup, value: active.dataset.value } : null;
            shapeMount.innerHTML = shapesHtml();
            if (focus) {
                const selector = `[data-shape="${focus.shape}"] ${focus.group ? `[data-shape-group="${focus.group}"] ` : ''}[data-shape-action="${focus.action}"]${focus.value ? `[data-value="${focus.value}"]` : ''}`;
                shapeMount.querySelector(selector)?.focus({ preventScroll: true });
            }
        };
        document.addEventListener('je:tag-layout-changed', syncShapes);
        cleanups.push(() => document.removeEventListener('je:tag-layout-changed', syncShapes));

        /** @param {Event} event - A shape select, switch, position or cap edit. */
        const editShape = (event) => {
            const control = event.target.closest('[data-shape-action]');
            const row = control?.closest('[data-shape]');
            if (!control || control.disabled || !row || !shapeMount?.contains(row)) return;
            const action = control.dataset.shapeAction;
            if ((event.type === 'change') !== ['enabled', 'layout', 'density', 'tagScale', 'tagGap'].includes(action)) return;
            const L = JE.core.tagLayout;
            const shape = row.dataset.shape;
            L.invalidateSettings();
            const shapes = L.readShapeOverrides(L.normalizeSettings().shapes);
            // Preserve the effective looks of both shapes before promotion.
            L.promoteLegacySettings(JE.currentSettings);
            let look = shapes[shape];
            if (action === 'enabled') {
                look = control.checked ? L.readShapeOverrides(L.RECOMMENDED_SHAPES)[shape] : null;
                // Just turned on: show its fields.
                if (control.checked) openShapes.add(shape);
            }
            else if (action === 'recommended') look = L.readShapeOverrides(L.RECOMMENDED_SHAPES)[shape];
            else if (look) {
                const group = control.closest('[data-shape-group]')?.dataset.shapeGroup;
                if (action === 'layout') { look.layout = control.value; look.slots = null; }
                if (action === 'density') look.density = control.value;
                if (action === 'tagScale' || action === 'tagGap') {
                    if (control.value) look[action] = control.value;
                    else delete look[action];
                }
                if (action === 'slot') look.slots = { ...(look.slots || {}), [group]: control.dataset.value };
                if (action === 'cap') {
                    const cap = L.resolveLayout({ shape }).caps[group];
                    const next = internal.tagGroupEditorData.stepCap(cap, Number(control.dataset.value), { capAll: true });
                    if (next === null) return;
                    look.caps = { ...(look.caps || {}), [group]: next };
                }
            }
            shapes[shape] = look;
            JE.currentSettings.tagShapeOverrides = L.shapesToWire(shapes) || { landscape: null, list: null };
            L.invalidateSettings();
            JE.saveUserSettings('settings.json', JE.currentSettings);
            JE.reinitializeTagLayout?.();
            preview?.follow(shape === 'landscape' ? 'episode' : 'list');
            preview?.refresh();
            touch();
        };
        shapeMount?.addEventListener('toggle', (e) => {
            const more = /** @type {HTMLDetailsElement} */ (e.target);
            const shape = more.closest?.('[data-shape]')?.dataset.shape;
            if (!shape || !more.matches?.('[data-shape-more]')) return;
            if (more.open) openShapes.add(shape); else openShapes.delete(shape);
        }, true);
        shapeMount?.addEventListener('change', editShape);
        shapeMount?.addEventListener('click', editShape);

        // Any change in the hub may change what the samples show: redraw
        // after the control's own handler (ui-panel-settings.js and the
        // editor, which listen closer to the control) saved it.
        hub.addEventListener('change', (e) => {
            const target = /** @type {HTMLInputElement} */ (e.target);
            if (target.name === 'jeTagLayout' && layoutDesc) layoutDesc.textContent = JE.t(`panel_settings_ui_tag_layout_${target.value}`);
            if (target.id === 'statusTagsToggle') syncLayoutChoice();
            preview?.refresh();
            if (BADGE_FAMILIES.some((f) => f.id === target.id)) {
                preview?.follow(['statusTagsScheduleToggle', 'statusTagsSeriesStatusToggle'].includes(target.id) ? 'series'
                    : target.id === 'statusTagsMilestonesToggle' ? 'episode' : 'movie');
            }
        });
        hub.addEventListener('click', (e) => {
            const target = /** @type {HTMLElement} */ (e.target);
            const goto = /** @type {HTMLElement|null} */ (target.closest('[data-je-goto]'));
            if (goto && goto.dataset.jeGoto?.startsWith('groups:')) {
                const group = goto.dataset.jeGoto.slice(7);
                select('groups');
                const row = hub.querySelector(`.je-tge-row[data-group="${group}"]`);
                const expand = /** @type {HTMLElement|null} */ (row?.querySelector('.je-tge-expand') || null);
                if (expand?.getAttribute('aria-expanded') !== 'true') expand?.click();
                expand?.focus();
                expand?.scrollIntoView?.({ block: 'nearest' });
                return;
            }
            if (target.closest('[data-je-config-link]')) {
                // The configuration page replaces the current view: the panel goes with it.
                ctx.closePanel?.();
                return;
            }
            if (target.closest('.je-tge-expand, .je-tge-move')) syncFocusOfPreview();
            if (target.closest('button, input, [role="tab"]')) preview?.refresh();
        });

        // ── Presets, import and export (ui-panel-tag-portable.js) ──
        const stopPortable = internal.wireTagPortable?.(hub, ctx, { announce });
        if (typeof stopPortable === 'function') cleanups.push(stopPortable);

        // ── Phone strip ──
        stripToggle?.addEventListener('click', () => {
            const open = stripToggle.getAttribute('aria-expanded') !== 'true';
            stripToggle.setAttribute('aria-expanded', String(open));
            hub.classList.toggle('je-mth-strip-open', open);
            touch();
        });

        // ── Colours: the three chips of each preset tile in that preset's real palette ──
        /**
         * Fetch every tile's palette once (GET tag-styles, the same answer the
         * web overlays use) and paint its chips with it. Inline !important,
         * so the user's own preset stylesheet can't bleed into another tile.
         */
        function loadPresetChips() {
            if (presetsLoaded || !hub.querySelector('#jeTagPresetChoice')) return;
            presetsLoaded = true;
            if (typeof ApiClient === 'undefined' || !ApiClient.ajax) return;
            hub.querySelectorAll('.je-mth-preset-chips').forEach((box) => {
                const preset = /** @type {HTMLElement} */ (box).dataset.preset;
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('JellyfinEnhanced/tag-styles', preset && preset !== 'server' ? { preset } : undefined), dataType: 'json' })
                    .then((styles) => {
                        if (disposed || !box.isConnected) return;
                        // Genre: the first genre the administrator coloured, else the sample one.
                        const genres = styles?.genre && typeof styles.genre === 'object' ? styles.genre : {};
                        const genre = Object.keys(genres).find((key) => key !== '*' && genres[key]) || GENRE_SAMPLE;
                        const pick = {
                            quality: styles?.quality?.['4K'] || styles?.quality?.['*'],
                            status: styles?.status?.added,
                            rating: styles?.rating?.community,
                            genre: genres[genre] || genres['*'],
                        };
                        const glyph = box.querySelector('[data-chip="genre"]');
                        if (glyph && genre !== GENRE_SAMPLE) {
                            /** @type {HTMLElement} */ (glyph).dataset.jeGenre = genre;
                            const icon = glyph.querySelector('.je-mth-chip-glyph');
                            if (icon) icon.textContent = JE.genreTags?.iconFor(genre) || 'theaters';
                        }
                        const sampled = styles?.preset === 'poster' ? JE.tagPosterColours : null;
                        box.querySelectorAll('[data-chip]').forEach((chip) => {
                            const kind = /** @type {HTMLElement} */ (chip).dataset.chip || 'quality';
                            const art = sampled ? sampled.normalise(POSTER_SAMPLE_ART[kind]) : null;
                            const base = art ? { background: sampled.css(art.background), color: sampled.css(art.text), border: sampled.css(art.border) } : CHIP_DEFAULTS[kind];
                            // Overrides the admin set stay on top, field by field.
                            const own = Object.fromEntries(Object.entries(pick[kind] || {}).filter(([, v]) => v));
                            const colours = { ...base, ...own };
                            const style = /** @type {HTMLElement} */ (chip).style;
                            style.setProperty('background', colours.background, 'important');
                            style.setProperty('color', colours.color, 'important');
                            style.setProperty('border-color', colours.border || 'transparent', 'important');
                        });
                    })
                    .catch((err) => console.warn('🪼 Jellyfin Enhanced: could not load a tag colour preset for the panel', err));
            });
        }

        // ── Preview: built the first time the section is on screen ──
        const mount = /** @type {HTMLElement|null} */ (hub.querySelector('#jeMthPreview'));
        const build = () => {
            if (preview || disposed || !mount) return;
            preview = internal.createTagPreview?.(mount, { strip: hub.querySelector('#jeMthStrip'), touch }) || null;
            syncFocusOfPreview();
        };
        if (mount && typeof window.IntersectionObserver === 'function') {
            io = new window.IntersectionObserver((entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    io?.disconnect();
                    io = null;
                    build();
                }
            });
            io.observe(hub);
        } else {
            build();
        }

        // ── Search: every control by its visible label ──
        /**
         * The hub's search entries: each control in a tab panel with its
         * label and where it sits ("Groups › Language").
         * @returns {Array<{label: string, path: string, el: HTMLElement}>}
         */
        const searchIndex = () => {
            const out = [];
            const seen = new Set();
            for (const panel of hub.querySelectorAll('[role="tabpanel"]')) {
                const tabName = JE.t(JE.core.tagLayout.VOCABULARY_KEYS.tab[`${/** @type {HTMLElement} */ (panel).dataset.tab}`]);
                const controls = panel.querySelectorAll('input:not([type="hidden"]), select, button, a[href], [role="group"][aria-labelledby], [role="radiogroup"][aria-labelledby]');
                for (const node of controls) {
                    const el = /** @type {HTMLElement} */ (node);
                    if (el.closest('datalist, [data-je-cap-control][hidden]')) continue;
                    const label = controlLabel(el);
                    if (!label) continue;
                    const row = /** @type {HTMLElement|null} */ (el.closest('.je-tge-row'));
                    const group = row ? (row.querySelector('.je-tge-name')?.textContent || '').trim() : '';
                    const path = [JE.t('common_media_tags'), tabName, group].filter(Boolean).join(' › ');
                    const key = `${path}|${label}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    out.push({ label, path, el });
                }
            }
            return out;
        };

        /**
         * Open the tab (and group, or locks list) a control is in, then focus it.
         * Opening the tab or a list can rebuild the control (the first visit
         * to Rules & locks redraws the locked items), so it is found again by
         * its stable key afterwards, or replaced by the nearest connected
         * stand-in: its rule row, else the tab panel's heading, else the tab.
         * @param {HTMLElement} el
         */
        const reveal = (el) => {
            // Read where the control sits before anything redraws it.
            const panel = /** @type {HTMLElement|null} */ (el.closest('[role="tabpanel"]'));
            const tabId = panel?.dataset.tab || 'layout';
            const focusKey = el.dataset.jeFocusKey || '';
            const elId = el.id;
            const ruleId = /** @type {HTMLElement|null} */ (el.closest('[data-je-rule-id]'))?.dataset.jeRuleId || '';
            const inLocks = !!el.closest('.je-tag-looks-locks');
            const body = /** @type {HTMLElement|null} */ (el.closest('.je-tge-body'));
            if (panel) select(tabId);
            if (body?.hidden) /** @type {HTMLElement|null} */ (body.closest('.je-tge-row')?.querySelector('.je-tge-expand') || null)?.click();
            const locksToggle = /** @type {HTMLElement|null} */ (inLocks ? hub.querySelector('.je-tag-looks-locks-toggle') : null);
            if (locksToggle && locksToggle.getAttribute('aria-expanded') === 'false' && locksToggle.offsetParent !== null) locksToggle.click();
            /** @param {string} attr @param {string} value @returns {HTMLElement|null} */
            const byData = (attr, value) => /** @type {HTMLElement|null} */ (Array.from(hub.querySelectorAll(`[${attr}]`)).find((node) => node.getAttribute(attr) === value) || null);
            let target = el.isConnected ? el
                : (focusKey && byData('data-je-focus-key', focusKey))
                || (elId && hub.contains(document.getElementById(elId)) && document.getElementById(elId))
                || (ruleId && byData('data-je-rule-id', ruleId))
                || /** @type {HTMLElement|null} */ (document.getElementById(`jeMthPanel-${tabId}`)?.querySelector('.je-mth-card-title, .je-tge-title') || null)
                || tabs.find((t) => t.dataset.tab === tabId)
                || el;
            // A control inside a closed disclosure (Quality's More options) is shown first.
            const closed = /** @type {HTMLDetailsElement|null} */ (target.closest('details:not([open])'));
            if (closed) closed.open = true;
            if (target !== el && !target.matches('button, input, select, a[href], [tabindex]')) target.tabIndex = -1;
            if (target.matches('[role="group"], [role="radiogroup"]')) {
                target = /** @type {HTMLElement} */ (target.querySelector('input:checked, button:not(:disabled), input:not(:disabled)') || target);
            }
            if (/** @type {HTMLButtonElement} */ (target).disabled) {
                target = /** @type {HTMLElement} */ (target.parentElement?.querySelector('button:not(:disabled), input:not(:disabled), select:not(:disabled)') || target);
            }
            target.scrollIntoView?.({ block: 'center' });
            target.focus({ preventScroll: true });
        };

        const unregister = ctx.registerSearch?.({
            pane: 'media-tags',
            /**
             * @param {string} query - Lower-case, trimmed.
             * @returns {Array<{label: string, path: string, run: () => void}>}
             */
            search(query) {
                const words = query.split(/\s+/).filter(Boolean);
                if (!words.length) return [];
                const scored = [];
                for (const entry of searchIndex()) {
                    const label = entry.label.toLowerCase();
                    const hay = `${entry.path} ${entry.label}`.toLowerCase();
                    if (!words.every((w) => hay.includes(w))) continue;
                    const score = label.startsWith(query) ? 0 : label.includes(query) ? 1 : 2;
                    scored.push({ score, entry });
                }
                scored.sort((a, b) => a.score - b.score);
                return scored.map(({ entry }) => ({ label: entry.label, path: entry.path, run: () => reveal(entry.el) }));
            },
        });
        if (typeof unregister === 'function') cleanups.push(unregister);

        // Start on the tab this user last had open (per user, this browser).
        let initial = 'layout';
        try { initial = window.localStorage.getItem(storeKey) || 'layout'; } catch { /* storage unavailable */ }
        if (!select(initial)) select('layout');

        /** Tear the hub down: the preview, its observer and every document listener. */
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            io?.disconnect();
            io = null;
            preview?.dispose();
            preview = null;
            while (cleanups.length) cleanups.pop()();
            if (internal.mediaTagsHub === api) internal.mediaTagsHub = null;
        };
        const api = {
            /** @param {string} id @param {{focus?: boolean, focusTab?: boolean}} [opts] */
            openTab: (id, opts) => select(id, opts),
            announce,
            refreshPreview: () => preview?.refresh(),
            hasPreview: () => !!preview,
            searchIndex,
            reveal,
            dispose,
        };
        internal.mediaTagsHub = api;
        ctx.onClose?.(dispose);
    };
})(window.JellyfinEnhanced);
