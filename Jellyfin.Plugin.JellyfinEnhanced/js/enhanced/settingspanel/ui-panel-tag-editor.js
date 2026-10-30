/**
 * @file Poster tag group editor in the personal settings panel (Media Tags):
 * one row per tag group in the user's priority order, each with move
 * up/down buttons, its enable toggle and an inline editor for the group's
 * slot in the selected layout, its cap and what it includes; plus the layout
 * and density selects, a reset button and a live preview card drawn through
 * the real layout controller (core/tag-layout.js) and chip classes.
 *
 * The enable toggles, quality categories, rating scopes, status badges and
 * sound language keep their element ids, so ui-panel-settings.js wires them
 * exactly as before; this module only adds the editor-owned controls.
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    /**
     * Per group: its enable toggle (id and setting key, unchanged), the
     * panel's name and description strings, the swatch colour, and its cap
     * rule: `capAll` groups may show every tag ("All" = 0), `capFixed`
     * groups always show one.
     */
    const GROUP_META = {
        status: { toggleId: 'statusTagsToggle', settingKey: 'statusTagsEnabled', nameKey: 'panel_settings_ui_tag_group_status', descKey: 'panel_settings_ui_status_tags_desc', color: '#e53935', capFixed: true },
        quality: { toggleId: 'qualityTagsToggle', settingKey: 'qualityTagsEnabled', nameKey: 'panel_settings_ui_tag_group_quality', descKey: 'panel_settings_ui_quality_tags_desc', color: '#1e88e5', capAll: true },
        rating: { toggleId: 'ratingTagsToggle', settingKey: 'ratingTagsEnabled', nameKey: 'panel_settings_ui_tag_group_rating', descKey: 'panel_settings_ui_rating_tags_desc', color: '#ffb300', capAll: true },
        ageRating: { toggleId: 'ageRatingTagsToggle', settingKey: 'ageRatingTagsEnabled', nameKey: 'panel_settings_ui_tag_group_age_rating', descKey: 'panel_settings_ui_age_rating_tags_desc', color: '#8e24aa', capFixed: true },
        language: { toggleId: 'languageTagsToggle', settingKey: 'languageTagsEnabled', nameKey: 'panel_settings_ui_tag_group_language', descKey: 'panel_settings_ui_language_tags_desc', color: '#43a047' },
        genre: { toggleId: 'genreTagsToggle', settingKey: 'genreTagsEnabled', nameKey: 'panel_settings_ui_tag_group_genre', descKey: 'panel_settings_ui_genre_tags_desc', color: '#00897b' },
    };
    const GROUP_IDS = Object.keys(GROUP_META);
    const LAYOUTS = ['corners', 'bands', 'caption', 'summary', 'minimal'];
    const MAX_CAP = 10;

    /** Quality categories: toggle/order keys (as the panel always had them) and the preview's sample chip. */
    const QUALITY_CATS = [
        { id: 'showResolutionTagToggle', settingKey: 'showResolutionTag', pluginKey: 'ShowResolutionTag', orderKey: 'resolutionTagOrder', orderPluginKey: 'ResolutionTagOrder', defaultOrder: 1, labelKey: 'panel_settings_ui_quality_tags_resolution', sample: ['4K', '4K', 'resolution'] },
        { id: 'showSourceTagToggle', settingKey: 'showSourceTag', pluginKey: 'ShowSourceTag', orderKey: 'sourceTagOrder', orderPluginKey: 'SourceTagOrder', defaultOrder: 2, labelKey: 'panel_settings_ui_quality_tags_source', sample: null },
        { id: 'showDynamicRangeTagToggle', settingKey: 'showDynamicRangeTag', pluginKey: 'ShowDynamicRangeTag', orderKey: 'dynamicRangeTagOrder', orderPluginKey: 'DynamicRangeTagOrder', defaultOrder: 3, labelKey: 'panel_settings_ui_quality_tags_dynamic_range', sample: ['Dolby Vision', 'Dolby Vision', 'video-codec'] },
        { id: 'showSpecialFormatTagToggle', settingKey: 'showSpecialFormatTag', pluginKey: 'ShowSpecialFormatTag', orderKey: 'specialFormatTagOrder', orderPluginKey: 'SpecialFormatTagOrder', defaultOrder: 4, labelKey: 'panel_settings_ui_quality_tags_special_format', sample: null },
        { id: 'showVideoCodecTagToggle', settingKey: 'showVideoCodecTag', pluginKey: 'ShowVideoCodecTag', orderKey: 'videoCodecTagOrder', orderPluginKey: 'VideoCodecTagOrder', defaultOrder: 5, labelKey: 'panel_settings_ui_quality_tags_video_codec', sample: ['HEVC', 'HEVC', 'video-format'] },
        { id: 'showAudioInfoTagToggle', settingKey: 'showAudioInfoTag', pluginKey: 'ShowAudioInfoTag', orderKey: 'audioInfoTagOrder', orderPluginKey: 'AudioInfoTagOrder', defaultOrder: 6, labelKey: 'panel_settings_ui_quality_tags_audio_info', sample: ['ATMOS 7.1', 'ATMOS', 'audio-codec'] },
    ];

    /** The rating group's include switches (user override → admin default → on). */
    const RATING_INCLUDES = [
        { settingKey: 'ratingTagsShowCommunity', pluginKey: 'RatingTagsShowCommunity', labelKey: 'panel_settings_ui_tag_editor_rating_community' },
        { settingKey: 'ratingTagsShowCritic', pluginKey: 'RatingTagsShowCritic', labelKey: 'panel_settings_ui_tag_editor_rating_critic' },
    ];

    /** Two flags drawn inline (data URIs), so the preview never touches the network. */
    const PREVIEW_FLAGS = [
        { code: 'jp', name: 'Japanese', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20"><rect width="30" height="20" fill="#fff"/><circle cx="15" cy="10" r="6" fill="#bc002d"/></svg>' },
        { code: 'fr', name: 'French', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 2"><rect width="1" height="2" fill="#002395"/><rect x="1" width="1" height="2" fill="#fff"/><rect x="2" width="1" height="2" fill="#ed2939"/></svg>' },
    ];
    const PREVIEW_GENRES = [['Science Fiction', 'science'], ['Thriller', 'psychology']];

    const escapeHtml = (value) => JE.escapeHtml(String(value));

    /** @returns {any} The layout controller (core/tag-layout.js), or null. */
    const layoutApi = () => JE.core?.tagLayout || null;

    /**
     * Effective layout settings, read fresh (the controller memoises them).
     * @returns {any}
     */
    function readConf() {
        const L = layoutApi();
        L.invalidateSettings();
        return L.normalizeSettings();
    }

    /**
     * The order the rows show: the effective order, or the default one for
     * documents that still use arrival order (written on the first move).
     * @param {any} conf
     * @returns {string[]}
     */
    function displayOrder(conf) {
        return (conf.order || layoutApi().DEFAULT_ORDER).slice();
    }

    /**
     * Label of a slot in a layout ("Bottom row"), or "Hidden" for off.
     * @param {string} layout
     * @param {string} slot
     * @returns {string}
     */
    function slotLabel(layout, slot) {
        return slot === 'off'
            ? JE.t('panel_settings_ui_tag_slot_off')
            : JE.t(`panel_settings_ui_tag_slot_${layout}_${slot}`);
    }

    /**
     * Slots a group may use in a layout (the minimal layout's dots are quality only).
     * @param {string} layout
     * @param {string} group
     * @returns {string[]}
     */
    function slotsFor(layout, group) {
        return layoutApi().LAYOUT_SLOTS[layout].filter((slot) => slot !== 'dots' || group === 'quality');
    }

    /**
     * The cap a group shows in the stepper.
     * @param {any} conf
     * @param {string} group
     * @returns {number} 0 = all.
     */
    function capOf(conf, group) {
        return GROUP_META[group].capFixed ? 1 : conf.caps[group];
    }

    /**
     * One-line row summary: "Bottom row · up to 3", "Top left · all tags", "Hidden".
     * @param {any} conf
     * @param {string} group
     * @returns {string}
     */
    function summaryOf(conf, group) {
        const slot = conf.profiles[conf.layout][group];
        if (slot === 'off') return slotLabel(conf.layout, slot);
        const where = slotLabel(conf.layout, slot);
        if (GROUP_META[group].capFixed) return where;
        const cap = capOf(conf, group);
        const count = cap === 0
            ? JE.t('panel_settings_ui_tag_editor_summary_all')
            : JE.t('panel_settings_ui_tag_editor_summary_up_to', { count: cap });
        return `${where} · ${count}`;
    }

    /**
     * Resolve a boolean setting: user override, then admin default, then on.
     * @param {string} userKey
     * @param {string} pluginKey
     * @returns {boolean}
     */
    function effectiveBool(userKey, pluginKey) {
        const u = JE.currentSettings?.[userKey];
        if (typeof u === 'boolean') return u;
        const a = JE.pluginConfig?.[pluginKey];
        return typeof a === 'boolean' ? a : true;
    }

    /**
     * Effective stack order of a quality category (user → admin → built-in).
     * @param {Object} cat
     * @returns {number}
     */
    function effectiveCatOrder(cat) {
        const u = JE.currentSettings?.[cat.orderKey];
        if (Number.isFinite(u)) return u;
        const a = JE.pluginConfig?.[cat.orderPluginKey];
        return Number.isFinite(a) ? a : cat.defaultOrder;
    }

    /** @returns {Object[]} The quality categories in their effective stack order. */
    function sortedQualityCats() {
        return QUALITY_CATS.slice().sort((a, b) => (effectiveCatOrder(a) - effectiveCatOrder(b)) || (a.defaultOrder - b.defaultOrder));
    }

    // ── Markup ─────────────────────────────────────────────────────────

    /**
     * Position pills for a group in a layout.
     * @param {any} conf
     * @param {string} group
     * @returns {string}
     */
    function pillsHtml(conf, group) {
        const current = conf.profiles[conf.layout][group];
        const name = JE.t(GROUP_META[group].nameKey);
        return slotsFor(conf.layout, group).map((slot) => {
            const label = slotLabel(conf.layout, slot);
            return `<button type="button" class="je-tge-pill" data-slot="${slot}" aria-pressed="${slot === current}" aria-label="${escapeHtml(`${name}: ${label}`)}">${escapeHtml(label)}</button>`;
        }).join('');
    }

    /**
     * The "Show up to" stepper value and button states for a group.
     * @param {any} conf
     * @param {string} group
     * @returns {{text: string, canDown: boolean, canUp: boolean}}
     */
    function stepperState(conf, group) {
        const meta = GROUP_META[group];
        const cap = capOf(conf, group);
        if (meta.capFixed) return { text: '1', canDown: false, canUp: false };
        return {
            text: cap === 0 ? JE.t('panel_settings_ui_tag_editor_cap_all') : String(cap),
            canDown: cap === 0 || cap > 1,
            canUp: cap !== 0 && (cap < MAX_CAP || !!meta.capAll),
        };
    }

    /**
     * The quality group's Include pills: the six category toggles with their
     * order buttons (the markup ui-panel-settings.js wires by id/class).
     * @returns {string}
     */
    function qualityIncludeHtml() {
        const sorted = sortedQualityCats();
        const up = escapeHtml(JE.t('panel_settings_ui_quality_tags_move_up'));
        const down = escapeHtml(JE.t('panel_settings_ui_quality_tags_move_down'));
        return `<div id="qualityTagsSubToggles" class="je-tge-cats">${sorted.map((c, idx) => `
            <div class="je-quality-cat-row je-tge-cat" data-cat-key="${c.settingKey}" data-order-key="${c.orderKey}" data-default-order="${c.defaultOrder}">
                <label class="je-tge-toggle-pill">
                    <input type="checkbox" id="${c.id}" ${effectiveBool(c.settingKey, c.pluginKey) ? 'checked' : ''}>
                    <span>${escapeHtml(JE.t(c.labelKey))}</span>
                </label>
                <button type="button" class="je-cat-btn je-cat-up" ${idx === 0 ? 'disabled' : ''} aria-label="${up}"><span class="material-icons" aria-hidden="true">arrow_upward</span></button>
                <button type="button" class="je-cat-btn je-cat-down" ${idx === sorted.length - 1 ? 'disabled' : ''} aria-label="${down}"><span class="material-icons" aria-hidden="true">arrow_downward</span></button>
            </div>`).join('')}
        </div>`;
    }

    /** @returns {string} The rating group's Include pills (community / critic). */
    function ratingIncludeHtml() {
        return `<div class="je-tge-includes je-tge-rating-includes">${RATING_INCLUDES.map((inc) => `
            <label class="je-tge-toggle-pill">
                <input type="checkbox" data-include-key="${inc.settingKey}" ${effectiveBool(inc.settingKey, inc.pluginKey) ? 'checked' : ''}>
                <span>${escapeHtml(JE.t(inc.labelKey))}</span>
            </label>`).join('')}
        </div>`;
    }

    /**
     * Group-specific settings that existed before the editor (sound
     * language, rating scope, status badges), kept with their ids.
     * @param {string} group
     * @param {Object} ctx - Panel context (colours).
     * @returns {string}
     */
    function extrasHtml(group, ctx) {
        const { detailsBackground, toggleAccentColor } = ctx;
        /** @param {string} key @param {string} pluginKey @param {string} id @param {string} labelKey */
        const scopeRow = (id, key, pluginKey, labelKey) => `
            <div class="je-quality-cat-row" data-cat-key="${key}">
                <label class="je-quality-cat-label-wrap">
                    <input type="checkbox" id="${id}" ${effectiveBool(key, pluginKey) ? 'checked' : ''} style="accent-color:${toggleAccentColor};">
                    <span class="je-quality-cat-label">${escapeHtml(JE.t(labelKey))}</span>
                </label>
            </div>`;
        if (group === 'quality') {
            return `
                <div class="je-quality-audio-lang je-tge-extra">
                    <label for="qualityTagsAudioLanguageSelect" class="je-tge-label">${escapeHtml(JE.t('panel_settings_ui_quality_tags_audio_language'))}</label>
                    <select id="qualityTagsAudioLanguageSelect" style="width:100%; background:${detailsBackground}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:6px; padding:6px;">
                        <option value="">${escapeHtml(JE.t('panel_settings_ui_quality_tags_audio_language_default'))}</option>
                        <option value="auto">${escapeHtml(JE.t('panel_settings_ui_quality_tags_audio_language_auto'))}</option>
                        <option value="none">${escapeHtml(JE.t('panel_settings_ui_quality_tags_audio_language_none'))}</option>
                    </select>
                    <div class="je-tge-hint">${escapeHtml(JE.t('panel_settings_ui_quality_tags_audio_language_desc'))}</div>
                </div>`;
        }
        if (group === 'rating') {
            return `
                <div class="je-tge-extra">
                    <div class="je-tge-label">${escapeHtml(JE.t('panel_settings_ui_rating_tags_scope_label'))}</div>
                    <div id="ratingTagsSubToggles" class="je-quality-cat-list je-tge-list-box">
                        ${scopeRow('ratingTagsOnMoviesToggle', 'ratingTagsOnMovies', 'RatingTagsOnMovies', 'panel_settings_ui_rating_tags_scope_movies')}
                        ${scopeRow('ratingTagsOnSeriesToggle', 'ratingTagsOnSeries', 'RatingTagsOnSeries', 'panel_settings_ui_rating_tags_scope_series')}
                        ${scopeRow('ratingTagsOnSeasonsToggle', 'ratingTagsOnSeasons', 'RatingTagsOnSeasons', 'panel_settings_ui_rating_tags_scope_seasons')}
                        ${scopeRow('ratingTagsOnEpisodesToggle', 'ratingTagsOnEpisodes', 'RatingTagsOnEpisodes', 'panel_settings_ui_rating_tags_scope_episodes')}
                        ${scopeRow('ratingTagsOnContinueWatchingToggle', 'ratingTagsOnContinueWatching', 'RatingTagsOnContinueWatching', 'panel_settings_ui_rating_tags_scope_continue_watching')}
                        ${scopeRow('ratingTagsOnNextUpToggle', 'ratingTagsOnNextUp', 'RatingTagsOnNextUp', 'panel_settings_ui_rating_tags_scope_next_up')}
                    </div>
                </div>`;
        }
        if (group === 'status') {
            return `
                <div class="je-tge-extra">
                    <div class="je-tge-label">${escapeHtml(JE.t('panel_settings_ui_status_tags_scope_label'))}</div>
                    <div id="statusTagsSubToggles" class="je-quality-cat-list je-tge-list-box">
                        ${scopeRow('statusTagsTrendingToggle', 'statusTagsTrending', 'StatusTagsTrending', 'panel_settings_ui_status_tags_trending')}
                        ${scopeRow('statusTagsNewReleaseToggle', 'statusTagsNewRelease', 'StatusTagsNewRelease', 'panel_settings_ui_status_tags_new_release')}
                        ${scopeRow('statusTagsJustAddedToggle', 'statusTagsJustAdded', 'StatusTagsJustAdded', 'panel_settings_ui_status_tags_just_added')}
                    </div>
                </div>`;
        }
        return '';
    }

    /**
     * One group row: header (move buttons, swatch, name + summary that
     * expands the editor, enable toggle) and the collapsed inline editor.
     * @param {any} conf
     * @param {string} group
     * @param {number} index - Position in the list.
     * @param {Object} ctx
     * @returns {string}
     */
    function rowHtml(conf, group, index, ctx) {
        const meta = GROUP_META[group];
        const name = JE.t(meta.nameKey);
        const step = stepperState(conf, group);
        const bodyId = `jeTgeBody-${group}`;
        let include;
        if (group === 'quality') include = qualityIncludeHtml();
        else if (group === 'rating') include = ratingIncludeHtml();
        else include = `<div class="je-tge-hint">${escapeHtml(JE.t('panel_settings_ui_tag_editor_nothing_to_include'))}</div>`;
        return `
            <li class="je-tge-row" data-group="${group}" style="--je-tge-swatch:${meta.color};">
                <div class="je-tge-row-head">
                    <div class="je-tge-moves">
                        <button type="button" class="je-tge-move" data-dir="up" ${index === 0 ? 'disabled' : ''} aria-label="${escapeHtml(JE.t('panel_settings_ui_tag_editor_move_up', { group: name }))}"><span class="material-icons" aria-hidden="true">arrow_upward</span></button>
                        <button type="button" class="je-tge-move" data-dir="down" ${index === GROUP_IDS.length - 1 ? 'disabled' : ''} aria-label="${escapeHtml(JE.t('panel_settings_ui_tag_editor_move_down', { group: name }))}"><span class="material-icons" aria-hidden="true">arrow_downward</span></button>
                    </div>
                    <span class="je-tge-swatch" aria-hidden="true"></span>
                    <button type="button" class="je-tge-expand" aria-expanded="false" aria-controls="${bodyId}">
                        <span class="je-tge-text">
                            <span class="je-tge-name">${escapeHtml(name)}</span>
                            <span class="je-tge-summary">${escapeHtml(summaryOf(conf, group))}</span>
                        </span>
                        <span class="material-icons je-tge-chevron" aria-hidden="true">expand_more</span>
                    </button>
                    <input type="checkbox" class="je-tge-enable" id="${meta.toggleId}" ${JE.currentSettings?.[meta.settingKey] ? 'checked' : ''} aria-label="${escapeHtml(JE.t('panel_settings_ui_tag_editor_enable', { group: name }))}" style="accent-color:${ctx.toggleAccentColor};">
                </div>
                <div class="je-tge-body" id="${bodyId}" hidden>
                    <div class="je-tge-hint">${escapeHtml(JE.t(meta.descKey))}</div>
                    <div class="je-tge-field" role="group" aria-label="${escapeHtml(JE.t('panel_settings_ui_tag_editor_position'))}">
                        <div class="je-tge-label" aria-hidden="true">${escapeHtml(JE.t('panel_settings_ui_tag_editor_position'))}</div>
                        <div class="je-tge-pills">${pillsHtml(conf, group)}</div>
                    </div>
                    <div class="je-tge-field">
                        <div class="je-tge-label" id="jeTgeCapLabel-${group}">${escapeHtml(JE.t('panel_settings_ui_tag_editor_show_up_to'))}</div>
                        <div class="je-tge-stepper" role="group" aria-labelledby="jeTgeCapLabel-${group}">
                            <button type="button" class="je-tge-step" data-step="-1" ${step.canDown ? '' : 'disabled'} aria-label="${escapeHtml(JE.t('panel_settings_ui_tag_editor_cap_decrease', { group: name }))}"><span class="material-icons" aria-hidden="true">remove</span></button>
                            <output class="je-tge-cap" aria-live="polite">${escapeHtml(step.text)}</output>
                            <button type="button" class="je-tge-step" data-step="1" ${step.canUp ? '' : 'disabled'} aria-label="${escapeHtml(JE.t('panel_settings_ui_tag_editor_cap_increase', { group: name }))}"><span class="material-icons" aria-hidden="true">add</span></button>
                        </div>
                    </div>
                    <div class="je-tge-field">
                        <div class="je-tge-label">${escapeHtml(JE.t('panel_settings_ui_tag_editor_include'))}</div>
                        ${include}
                    </div>
                    ${extrasHtml(group, ctx)}
                </div>
            </li>`;
    }

    /**
     * The whole Media Tags editor: layout/density selects, reset and the
     * preview mount, then the group rows in priority order.
     * @param {Object} ctx - Panel context from ui-panel.js.
     * @returns {string}
     */
    internal.buildTagGroupEditorHtml = function(ctx) {
        const { detailsBackground, presetBoxBackground, toggleAccentColor } = ctx;
        const L = layoutApi();
        if (!L) return '';
        const conf = readConf();
        const selectStyle = `width:100%; background:${detailsBackground}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:6px; padding:6px;`;
        const rows = displayOrder(conf).map((group, i) => rowHtml(conf, group, i, ctx)).join('');
        return `
            <div class="je-tge" id="jeTagGroupEditor" style="--je-tge-box:${presetBoxBackground}; --je-tge-accent:${toggleAccentColor};">
                <div class="je-tge-head">
                    <div class="je-tge-controls">
                        <div class="je-tge-select">
                            <label for="tagLayoutSelect">${escapeHtml(JE.t('panel_settings_ui_tag_layout'))}</label>
                            <div id="tagLayoutSelectDesc" class="je-tge-hint">${escapeHtml(JE.t('panel_settings_ui_tag_layout_desc'))}</div>
                            <select id="tagLayoutSelect" aria-describedby="tagLayoutSelectDesc" style="${selectStyle}">
                                ${LAYOUTS.map((id) => `<option value="${id}" ${conf.layout === id ? 'selected' : ''}>${escapeHtml(JE.t(`panel_settings_ui_tag_layout_${id}`))}</option>`).join('')}
                            </select>
                        </div>
                        <div class="je-tge-select">
                            <label for="tagLabelDensitySelect">${escapeHtml(JE.t('panel_settings_ui_tag_density'))}</label>
                            <div id="tagLabelDensityDesc" class="je-tge-hint">${escapeHtml(JE.t('panel_settings_ui_tag_density_desc'))}</div>
                            <select id="tagLabelDensitySelect" aria-describedby="tagLabelDensityDesc" style="${selectStyle}">
                                <option value="full" ${conf.density !== 'compact' ? 'selected' : ''}>${escapeHtml(JE.t('panel_settings_ui_tag_density_full'))}</option>
                                <option value="compact" ${conf.density === 'compact' ? 'selected' : ''}>${escapeHtml(JE.t('panel_settings_ui_tag_density_compact'))}</option>
                            </select>
                        </div>
                        <button type="button" class="je-tge-reset" id="jeTgeReset"><span class="material-icons" aria-hidden="true">restart_alt</span><span>${escapeHtml(JE.t('panel_settings_ui_tag_editor_reset'))}</span></button>
                    </div>
                    <figure class="je-tge-preview" aria-label="${escapeHtml(JE.t('panel_settings_ui_tag_editor_preview'))}">
                        <div class="je-tge-preview-mount" id="jeTgePreview"></div>
                        <figcaption class="je-tge-view" role="group" aria-label="${escapeHtml(JE.t('panel_settings_ui_tag_editor_preview'))}">
                            <button type="button" data-view="rest" aria-pressed="true">${escapeHtml(JE.t('panel_settings_ui_tag_editor_preview_resting'))}</button>
                            <button type="button" data-view="hover" aria-pressed="false">${escapeHtml(JE.t('panel_settings_ui_tag_editor_preview_hover'))}</button>
                        </figcaption>
                    </figure>
                </div>
                <div class="je-tge-title">${escapeHtml(JE.t('panel_settings_ui_tag_editor_title'))}</div>
                <div class="je-tge-hint">${escapeHtml(JE.t('panel_settings_ui_tag_editor_desc'))}</div>
                <ol class="je-tge-rows">${rows}</ol>
            </div>`;
    };

    // ── Writes ─────────────────────────────────────────────────────────

    /**
     * Before the first layout write, turn a legacy document into a normalized
     * one that still shows exactly what it showed (core/tag-layout.js
     * promoteLegacySettings), so one edit changes only what it edits.
     */
    function promote() {
        layoutApi().promoteLegacySettings(JE.currentSettings);
    }

    /**
     * Save the (already promoted) layout document and re-present every card.
     */
    function saveLayout() {
        layoutApi().invalidateSettings();
        JE.saveUserSettings('settings.json', JE.currentSettings);
        if (typeof JE.reinitializeTagLayout === 'function') JE.reinitializeTagLayout();
    }

    /**
     * Set a group's slot in one layout profile. For corners, the matching old
     * position setting follows (Native Poster Tags and older clients read it).
     * @param {string} layout
     * @param {string} group
     * @param {string} slot
     */
    function writeSlot(layout, group, slot) {
        const L = layoutApi();
        promote();
        const profiles = JE.currentSettings.tagLayouts && typeof JE.currentSettings.tagLayouts === 'object'
            ? { ...JE.currentSettings.tagLayouts } : {};
        const pascal = layout.charAt(0).toUpperCase() + layout.slice(1);
        const profile = profiles[layout] || profiles[pascal] || {};
        const entries = (Array.isArray(profile.groups) ? profile.groups : Array.isArray(profile.Groups) ? profile.Groups : [])
            .filter((entry) => L.normalizeGroup(entry?.group ?? entry?.Group) !== group);
        entries.push({ group, slot });
        delete profiles[pascal];
        profiles[layout] = { groups: entries };
        JE.currentSettings.tagLayouts = profiles;
        if (layout === 'corners' && L.SLOT_TO_POSITION[slot]) {
            JE.currentSettings[L.POSITION_SETTINGS[group].userKey] = L.SLOT_TO_POSITION[slot];
        }
        saveLayout();
    }

    /**
     * Set a group's cap (0 = all), clamped to what the group allows.
     * @param {string} group
     * @param {number} cap
     */
    function writeCap(group, cap) {
        promote();
        const caps = {};
        const own = JE.currentSettings.tagGroupCaps;
        if (own && typeof own === 'object') {
            for (const [key, value] of Object.entries(own)) {
                const id = layoutApi().normalizeGroup(key);
                if (id && id !== group) caps[id] = value;
            }
        }
        caps[group] = Math.max(0, Math.min(MAX_CAP, cap));
        JE.currentSettings.tagGroupCaps = caps;
        saveLayout();
        if (group === 'genre') refillGenres();
    }

    /**
     * Genre entries cached by older versions hold three genres; re-render so a
     * larger cap refills them (the renderer treats them as misses). Called after
     * any change that can raise the genre cap.
     */
    function refillGenres() {
        if (JE.currentSettings.genreTagsEnabled && typeof JE.reinitializeGenreTags === 'function') {
            JE.reinitializeGenreTags();
        }
    }

    /**
     * The next cap a stepper press gives: 1..10, with "All" (0) above 10 for
     * groups that allow it.
     * @param {string} group
     * @param {number} cap - Current cap (0 = all).
     * @param {number} dir - +1 or -1.
     * @returns {number|null} Null when the press does nothing.
     */
    function nextCap(group, cap, dir) {
        const meta = GROUP_META[group];
        if (meta.capFixed) return null;
        if (dir < 0) {
            if (cap === 0) return MAX_CAP;
            return cap > 1 ? cap - 1 : null;
        }
        if (cap === 0) return null;
        if (cap < MAX_CAP) return cap + 1;
        return meta.capAll ? 0 : null;
    }

    /**
     * Restore the administrator's layout defaults (layout, density, slot
     * profiles, the corner positions, order and caps), as "apply defaults to
     * all users" would. Enable toggles, include choices and personal rules
     * are kept; rules are not layout defaults.
     */
    function resetToDefaults() {
        promote();
        const L = layoutApi();
        const p = JE.pluginConfig || {};
        const copy = (value) => (value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : null);
        const adminLayout = String(p.TagLayout || '').toLowerCase();
        JE.currentSettings.tagLayout = LAYOUTS.includes(adminLayout) ? adminLayout : 'corners';
        JE.currentSettings.tagLabelDensity = String(p.TagLabelDensity || '').toLowerCase() === 'compact' ? 'compact' : 'full';
        JE.currentSettings.tagLayouts = copy(p.TagLayouts);
        JE.currentSettings.tagGroupOrder = Array.isArray(p.TagGroupOrder) ? p.TagGroupOrder.slice() : null;
        JE.currentSettings.tagGroupCaps = copy(p.TagGroupCaps);
        JE.currentSettings.tagLayoutSettingsVersion = 1;
        for (const pos of Object.values(L.POSITION_SETTINGS)) {
            JE.currentSettings[pos.userKey] = p[pos.pluginKey] || pos.fallback;
        }
        saveLayout();
        refillGenres();
    }

    // ── Live preview ───────────────────────────────────────────────────

    /**
     * Build a sample group wrapper with the renderer's real classes.
     * @param {string} group
     * @returns {HTMLElement|null} Null when the group has nothing to show.
     */
    function sampleGroup(group) {
        const L = layoutApi();
        const wrap = document.createElement('div');
        wrap.className = L.CONTAINER_CLASS[group];
        const add = (className, text) => {
            const el = document.createElement('div');
            el.className = className;
            if (text !== undefined) el.textContent = text;
            wrap.appendChild(el);
            return el;
        };
        switch (group) {
            case 'quality':
                for (const cat of sortedQualityCats()) {
                    if (!cat.sample || !effectiveBool(cat.settingKey, cat.pluginKey)) continue;
                    const [label, key, kind] = cat.sample;
                    add(`quality-overlay-label ${kind}`, label).dataset.quality = key;
                }
                break;
            case 'rating':
                if (effectiveBool('ratingTagsShowCritic', 'RatingTagsShowCritic')) {
                    const chip = add('rating-tag rating-tag-critic');
                    const icon = document.createElement('span');
                    icon.className = 'rating-tomato-icon fresh';
                    const text = document.createElement('span');
                    text.className = 'rating-text';
                    text.textContent = '88%';
                    chip.append(icon, text);
                }
                if (effectiveBool('ratingTagsShowCommunity', 'RatingTagsShowCommunity')) {
                    const chip = add('rating-tag rating-tag-tmdb');
                    const star = document.createElement('span');
                    star.className = 'material-icons rating-star-icon';
                    star.textContent = 'star';
                    const text = document.createElement('span');
                    text.className = 'rating-text';
                    text.textContent = '8.1';
                    chip.append(star, text);
                }
                break;
            case 'ageRating':
                add('age-rating-tag', 'PG-13').setAttribute('rating', 'PG-13');
                break;
            case 'language':
                for (const flag of PREVIEW_FLAGS) {
                    const img = document.createElement('img');
                    img.className = 'language-flag';
                    img.src = `data:image/svg+xml,${encodeURIComponent(flag.svg)}`;
                    img.alt = flag.name;
                    img.title = flag.name;
                    img.dataset.lang = flag.code;
                    img.dataset.langName = flag.name;
                    wrap.appendChild(img);
                }
                break;
            case 'genre':
                for (const [name, icon] of PREVIEW_GENRES) {
                    const chip = add('genre-tag');
                    chip.title = name;
                    const glyph = document.createElement('span');
                    glyph.className = 'je-msym-outlined';
                    glyph.textContent = icon;
                    chip.appendChild(glyph);
                    if (!JE.currentSettings?.tagsHideOnHover) {
                        const text = document.createElement('span');
                        text.className = 'genre-text';
                        text.textContent = name;
                        chip.appendChild(text);
                    }
                }
                break;
            case 'status':
                add('status-tag status-tag--added', JE.t('status_tag_just_added'));
                break;
            default:
                return null;
        }
        return wrap.children.length ? wrap : null;
    }

    /**
     * The synthetic poster card the preview draws into. It carries the card
     * structure the layout controller needs (.cardBox > .cardScalable + a
     * title block for the caption outlet) but neither .card nor
     * .cardImageContainer, so the tag pipeline and other card features never
     * pick it up, and only the Resting/Hover switch reveals hover chips.
     * @returns {HTMLElement}
     */
    function buildPreviewCard() {
        const card = document.createElement('div');
        card.className = 'je-tge-card';
        card.setAttribute('aria-hidden', 'true');
        const box = document.createElement('div');
        box.className = 'cardBox';
        const scalable = document.createElement('div');
        scalable.className = 'cardScalable je-tge-card-scalable';
        const art = document.createElement('div');
        art.className = 'je-tge-card-art';
        const overlay = document.createElement('div');
        overlay.className = 'cardOverlayContainer';
        scalable.append(art, overlay);
        const title = document.createElement('div');
        title.className = 'cardText je-tge-card-title';
        title.textContent = JE.t('panel_settings_ui_tag_editor_preview_title');
        box.append(scalable, title);
        card.appendChild(box);
        return card;
    }

    /**
     * Re-feed the preview card's sample groups (enabled groups only) and
     * re-present it through the layout controller.
     * @param {HTMLElement} card
     */
    function refreshPreview(card) {
        const L = layoutApi();
        if (!L || !card?.isConnected) return;
        const target = /** @type {HTMLElement} */ (card.querySelector('.cardScalable'));
        L.invalidateSettings();
        for (const group of GROUP_IDS) {
            const sample = JE.currentSettings?.[GROUP_META[group].settingKey] ? sampleGroup(group) : null;
            if (sample) L.commitGroup(target, group, sample);
            else L.removeGroup(target, group);
        }
        L.refreshPresentation(target);
    }

    /** CSS for the editor and its preview (panel-scoped). */
    const EDITOR_CSS = `
        #jellyfin-enhanced-panel .je-tge { margin-bottom: 16px; padding: 12px; background: var(--je-tge-box); border-radius: 6px; border-left: 3px solid var(--je-tge-accent); }
        #jellyfin-enhanced-panel .je-tge-head { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
        #jellyfin-enhanced-panel .je-tge-controls { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
        #jellyfin-enhanced-panel .je-tge-select label, #jellyfin-enhanced-panel .je-tge-title { font-weight: 500; }
        #jellyfin-enhanced-panel .je-tge-title { margin-top: 16px; }
        #jellyfin-enhanced-panel .je-tge-hint { font-size: 12px; color: rgba(255,255,255,0.6); margin: 2px 0 6px; }
        #jellyfin-enhanced-panel .je-tge-label { font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.75); margin-bottom: 6px; }
        #jellyfin-enhanced-panel .je-tge-reset { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.05); color: #fff; border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; padding: 6px 10px; font: inherit; font-size: 13px; cursor: pointer; }
        #jellyfin-enhanced-panel .je-tge-reset .material-icons { font-size: 18px; }
        #jellyfin-enhanced-panel .je-tge-preview { flex: 0 0 auto; margin: 0; display: flex; flex-direction: column; align-items: center; gap: 8px; }
        #jellyfin-enhanced-panel .je-tge-preview-mount { width: 150px; min-height: 225px; }
        #jellyfin-enhanced-panel .je-tge-card { width: 150px; }
        #jellyfin-enhanced-panel .je-tge-card .cardBox { margin: 0; }
        #jellyfin-enhanced-panel .je-tge-card-scalable { position: relative; width: 150px; height: 225px; border-radius: 6px; overflow: hidden; contain: paint; }
        #jellyfin-enhanced-panel .je-tge-card-art { position: absolute; inset: 0; background: linear-gradient(160deg, #3a4a6b 0%, #1c2233 55%, #0d1018 100%); }
        #jellyfin-enhanced-panel .je-tge-card-art::after { content: ''; position: absolute; left: 22%; right: 22%; top: 30%; height: 34%; border-radius: 50% 50% 8px 8px; background: rgba(255,255,255,0.07); }
        #jellyfin-enhanced-panel .je-tge-card .cardOverlayContainer { display: none; }
        #jellyfin-enhanced-panel .je-tge-card .je-tag-host { position: absolute; inset: 0; pointer-events: none; container-type: inline-size; }
        #jellyfin-enhanced-panel .je-tge-card-title { font-size: 13px; padding: 4px 2px 0; color: rgba(255,255,255,0.85); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; }
        #jellyfin-enhanced-panel .je-tge-view { display: inline-flex; border: 1px solid rgba(255,255,255,0.2); border-radius: 999px; overflow: hidden; }
        #jellyfin-enhanced-panel .je-tge-view button { background: transparent; color: rgba(255,255,255,0.8); border: 0; padding: 4px 12px; font: inherit; font-size: 12px; cursor: pointer; }
        #jellyfin-enhanced-panel .je-tge-view button[aria-pressed="true"] { background: var(--je-tge-accent); color: #fff; }
        #jellyfin-enhanced-panel .je-tge-rows { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
        #jellyfin-enhanced-panel .je-tge-row { border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; background: rgba(0,0,0,0.15); }
        #jellyfin-enhanced-panel .je-tge-row-head { display: flex; align-items: center; gap: 8px; padding: 6px 8px; }
        #jellyfin-enhanced-panel .je-tge-moves { display: flex; gap: 2px; flex-shrink: 0; }
        #jellyfin-enhanced-panel .je-tge-move, #jellyfin-enhanced-panel .je-tge-step { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.15); color: rgba(255,255,255,0.85); border-radius: 4px; width: 28px; height: 28px; padding: 0; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
        #jellyfin-enhanced-panel .je-tge-move .material-icons, #jellyfin-enhanced-panel .je-tge-step .material-icons { font-size: 16px; }
        #jellyfin-enhanced-panel .je-tge-move:disabled, #jellyfin-enhanced-panel .je-tge-step:disabled { opacity: 0.35; cursor: not-allowed; }
        #jellyfin-enhanced-panel .je-tge-swatch { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; background: var(--je-tge-swatch); }
        #jellyfin-enhanced-panel .je-tge-expand { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; background: transparent; border: 0; color: #fff; text-align: left; padding: 4px; font: inherit; cursor: pointer; border-radius: 4px; }
        #jellyfin-enhanced-panel .je-tge-text { flex: 1; min-width: 0; display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 10px; }
        #jellyfin-enhanced-panel .je-tge-name { font-weight: 500; }
        #jellyfin-enhanced-panel .je-tge-summary { font-size: 12px; color: rgba(255,255,255,0.6); }
        #jellyfin-enhanced-panel .je-tge-chevron { flex-shrink: 0; font-size: 20px; transition: transform 0.2s ease; }
        #jellyfin-enhanced-panel .je-tge-expand[aria-expanded="true"] .je-tge-chevron { transform: rotate(180deg); }
        #jellyfin-enhanced-panel .je-tge-enable { width: 18px; height: 18px; flex-shrink: 0; cursor: pointer; }
        #jellyfin-enhanced-panel .je-tge-body { padding: 4px 12px 12px; border-top: 1px solid rgba(255,255,255,0.08); display: flex; flex-direction: column; gap: 12px; }
        #jellyfin-enhanced-panel .je-tge-body[hidden] { display: none; }
        #jellyfin-enhanced-panel .je-tge-pills, #jellyfin-enhanced-panel .je-tge-includes, #jellyfin-enhanced-panel .je-tge-cats { display: flex; flex-wrap: wrap; gap: 6px; }
        #jellyfin-enhanced-panel .je-tge-pill, #jellyfin-enhanced-panel .je-tge-toggle-pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid rgba(255,255,255,0.22); border-radius: 999px; padding: 4px 12px; background: transparent; color: rgba(255,255,255,0.85); font: inherit; font-size: 12px; cursor: pointer; }
        #jellyfin-enhanced-panel .je-tge-pill[aria-pressed="true"], #jellyfin-enhanced-panel .je-tge-toggle-pill:has(input:checked) { background: var(--je-tge-accent); border-color: var(--je-tge-accent); color: #fff; }
        #jellyfin-enhanced-panel .je-tge-toggle-pill input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; }
        #jellyfin-enhanced-panel .je-tge-toggle-pill:has(input:focus-visible) { outline: 2px solid #fff; outline-offset: 2px; }
        #jellyfin-enhanced-panel .je-tge-cat { display: inline-flex; align-items: center; gap: 2px; padding: 0; border: 0; }
        #jellyfin-enhanced-panel .je-tge-cat .je-cat-btn { width: 24px; height: 24px; padding: 0; justify-content: center; }
        #jellyfin-enhanced-panel .je-tge-cat .je-cat-btn .material-icons { font-size: 14px; }
        #jellyfin-enhanced-panel .je-tge-stepper { display: inline-flex; align-items: center; gap: 8px; }
        #jellyfin-enhanced-panel .je-tge-cap { min-width: 32px; text-align: center; font-weight: 600; }
        #jellyfin-enhanced-panel .je-tge-list-box { margin: 0; }
        #jellyfin-enhanced-panel .je-tge :is(button, select, input):focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { #jellyfin-enhanced-panel .je-tge-chevron { transition: none; } }
    `;

    /**
     * Wire the editor-owned controls (moves, expand, pills, stepper, rating
     * includes, reset, preview switch), keep the rows in step with the
     * settings after any change, and build the preview card once the editor
     * is first on screen. The editor is disposed when the panel closes
     * (ctx.onClose) or is wired again.
     * @param {Object} ctx - Panel context ({ resetAutoCloseTimer, onClose }).
     */
    internal.wireTagGroupEditor = function(ctx) {
        internal.tagGroupEditor?.dispose();
        const root = document.getElementById('jeTagGroupEditor');
        const L = layoutApi();
        if (!root || !L) return;
        JE.core.ui?.injectCss?.('je-tag-group-editor', EDITOR_CSS);
        const list = /** @type {HTMLElement} */ (root.querySelector('.je-tge-rows'));
        const touch = () => ctx.resetAutoCloseTimer?.();
        /** @type {HTMLElement|null} */
        let previewCard = null;
        let refreshQueued = false;
        let disposed = false;
        /** @type {IntersectionObserver|null} */
        let io = null;

        /** Re-render the preview after the current event's handlers ran. */
        const queuePreview = () => {
            if (refreshQueued || !previewCard || disposed) return;
            refreshQueued = true;
            Promise.resolve().then(() => {
                refreshQueued = false;
                if (!disposed && previewCard) refreshPreview(previewCard);
            });
        };

        /** Bring every row (order, summary, pills, stepper, move buttons) and both selects in step with the settings. */
        const sync = () => {
            const conf = readConf();
            const order = displayOrder(conf);
            for (const group of order) {
                const row = list.querySelector(`.je-tge-row[data-group="${group}"]`);
                if (row) list.appendChild(row);
            }
            const rows = Array.from(list.querySelectorAll('.je-tge-row'));
            rows.forEach((row, index) => {
                const group = /** @type {HTMLElement} */ (row).dataset.group || '';
                /** @type {HTMLButtonElement} */ (row.querySelector('.je-tge-move[data-dir="up"]')).disabled = index === 0;
                /** @type {HTMLButtonElement} */ (row.querySelector('.je-tge-move[data-dir="down"]')).disabled = index === rows.length - 1;
                /** @type {HTMLElement} */ (row.querySelector('.je-tge-summary')).textContent = summaryOf(conf, group);
                const pills = /** @type {HTMLElement} */ (row.querySelector('.je-tge-pills'));
                const focused = pills.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement).dataset.slot : null;
                pills.innerHTML = pillsHtml(conf, group);
                if (focused) /** @type {HTMLElement|null} */ (pills.querySelector(`[data-slot="${focused}"]`))?.focus();
                const step = stepperState(conf, group);
                /** @type {HTMLElement} */ (row.querySelector('.je-tge-cap')).textContent = step.text;
                /** @type {HTMLButtonElement} */ (row.querySelector('.je-tge-step[data-step="-1"]')).disabled = !step.canDown;
                /** @type {HTMLButtonElement} */ (row.querySelector('.je-tge-step[data-step="1"]')).disabled = !step.canUp;
            });
            const layoutSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('tagLayoutSelect'));
            if (layoutSelect) layoutSelect.value = conf.layout;
            const densitySelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('tagLabelDensitySelect'));
            if (densitySelect) densitySelect.value = conf.density;
        };

        root.addEventListener('click', (e) => {
            const target = /** @type {HTMLElement} */ (e.target);
            const row = /** @type {HTMLElement|null} */ (target.closest('.je-tge-row'));
            const group = row?.dataset.group || '';

            const move = /** @type {HTMLButtonElement|null} */ (target.closest('.je-tge-move'));
            if (move && row && !move.disabled) {
                const order = displayOrder(readConf());
                const from = order.indexOf(group);
                const to = from + (move.dataset.dir === 'up' ? -1 : 1);
                if (from < 0 || to < 0 || to >= order.length) return;
                order.splice(to, 0, order.splice(from, 1)[0]);
                promote();
                JE.currentSettings.tagGroupOrder = order;
                saveLayout();
                sync();
                // Keep focus on the group's control; at an end, on its other move button.
                const same = /** @type {HTMLButtonElement} */ (row.querySelector(`.je-tge-move[data-dir="${move.dataset.dir}"]`));
                (same.disabled ? /** @type {HTMLElement} */ (row.querySelector('.je-tge-move:not(:disabled)')) : same)?.focus();
                queuePreview();
                touch();
                return;
            }

            const expand = /** @type {HTMLElement|null} */ (target.closest('.je-tge-expand'));
            if (expand && row) {
                const open = expand.getAttribute('aria-expanded') !== 'true';
                expand.setAttribute('aria-expanded', String(open));
                /** @type {HTMLElement} */ (row.querySelector('.je-tge-body')).hidden = !open;
                touch();
                return;
            }

            const pill = /** @type {HTMLElement|null} */ (target.closest('.je-tge-pill'));
            if (pill && row) {
                writeSlot(readConf().layout, group, pill.dataset.slot || 'off');
                sync();
                queuePreview();
                touch();
                return;
            }

            const step = /** @type {HTMLButtonElement|null} */ (target.closest('.je-tge-step'));
            if (step && row && !step.disabled) {
                const next = nextCap(group, capOf(readConf(), group), Number(step.dataset.step));
                if (next !== null) writeCap(group, next);
                sync();
                // The pressed button may have just been disabled (an end of the range).
                if (step.disabled) /** @type {HTMLElement|null} */ (row.querySelector('.je-tge-step:not(:disabled)'))?.focus();
                queuePreview();
                touch();
                return;
            }

            if (target.closest('#jeTgeReset')) {
                resetToDefaults();
                sync();
                queuePreview();
                JE.toast(JE.t('toast_tag_layout_reset'));
                touch();
                return;
            }

            const view = /** @type {HTMLElement|null} */ (target.closest('.je-tge-view [data-view]'));
            if (view) {
                const hover = view.dataset.view === 'hover';
                root.querySelectorAll('.je-tge-view [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b === view)));
                previewCard?.classList.toggle('je-tag-reveal', hover);
                touch();
                return;
            }

            // Quality category order buttons (wired in ui-panel-settings.js).
            if (target.closest('.je-cat-btn')) queuePreview();
        });

        root.addEventListener('change', (e) => {
            const target = /** @type {HTMLInputElement} */ (e.target);
            const includeKey = target.dataset?.includeKey;
            if (includeKey) {
                JE.currentSettings[includeKey] = target.checked;
                JE.saveUserSettings('settings.json', JE.currentSettings);
                if (JE.currentSettings.ratingTagsEnabled && typeof JE.reinitializeRatingTags === 'function') {
                    JE.reinitializeRatingTags();
                }
                touch();
            }
            // Layout / density selects and enable toggles are saved by
            // ui-panel-settings.js (its listeners run first); re-label here.
            if (target.id === 'tagLayoutSelect' || target.id === 'tagLabelDensitySelect') sync();
            queuePreview();
        });

        // Build the preview the first time the editor is on screen (the
        // panel opens on another section most of the time).
        let mount = document.getElementById('jeTgePreview');
        const build = () => {
            if (previewCard || !mount || disposed) return;
            previewCard = buildPreviewCard();
            mount.appendChild(previewCard);
            refreshPreview(previewCard);
        };
        if (mount && typeof window.IntersectionObserver === 'function') {
            io = new window.IntersectionObserver((entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    io?.disconnect();
                    io = null;
                    build();
                }
            });
            io.observe(mount);
        } else {
            build();
        }

        /**
         * Tear the editor down: stop watching for the preview, drop the
         * preview card and the element references, and ignore preview work
         * still queued. The panel's markup goes with the panel.
         */
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            io?.disconnect();
            io = null;
            if (previewCard) L.clearCard(previewCard.querySelector('.cardScalable'));
            previewCard?.remove();
            previewCard = null;
            mount = null;
            if (internal.tagGroupEditor === api) internal.tagGroupEditor = null;
        };
        const api = { sync, refreshPreview: () => previewCard && refreshPreview(previewCard), nextCap, dispose };
        internal.tagGroupEditor = api;
        ctx.onClose?.(dispose);
    };
})(window.JellyfinEnhanced);
