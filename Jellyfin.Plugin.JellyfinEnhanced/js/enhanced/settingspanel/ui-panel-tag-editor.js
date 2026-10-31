/**
 * @file Poster tag group editor, the Groups tab of the settings panel's
 * Media Tags hub (ui-panel-media-tags.js): one row per tag group in the
 * user's priority order, each with move up/down buttons, its enable toggle
 * and an inline editor for the group's slot in the selected layout, its cap
 * and what it includes, plus a reset button. The Status row links to the
 * hub's Status badges tab, where the badge families live; the layout and
 * density choices and the live preview are the hub's.
 *
 * The enable toggles, quality categories, rating scopes and sound language
 * keep their element ids, so ui-panel-settings.js wires them exactly as
 * before; this module only adds the editor-owned controls.
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
        awards: { toggleId: 'awardsTagsToggle', settingKey: 'awardsTagsEnabled', nameKey: 'awards_tags_group', descKey: 'awards_tags_description', color: '#d7ae52', capAll: true },
        status: { toggleId: 'statusTagsToggle', settingKey: 'statusTagsEnabled', nameKey: 'panel_settings_ui_tag_group_status', descKey: 'panel_settings_ui_status_tags_desc', color: '#e53935', capFixed: true },
        quality: { toggleId: 'qualityTagsToggle', settingKey: 'qualityTagsEnabled', nameKey: 'panel_settings_ui_tag_group_quality', descKey: 'panel_settings_ui_quality_tags_desc', color: '#1e88e5', capAll: true },
        rating: { toggleId: 'ratingTagsToggle', settingKey: 'ratingTagsEnabled', nameKey: 'panel_settings_ui_tag_group_rating', descKey: 'panel_settings_ui_rating_tags_desc', color: '#ffb300', capAll: true },
        ageRating: { toggleId: 'ageRatingTagsToggle', settingKey: 'ageRatingTagsEnabled', nameKey: 'panel_settings_ui_tag_group_age_rating', descKey: 'panel_settings_ui_age_rating_tags_desc', color: '#8e24aa', capFixed: true },
        language: { toggleId: 'languageTagsToggle', settingKey: 'languageTagsEnabled', nameKey: 'panel_settings_ui_tag_group_language', descKey: 'panel_settings_ui_language_tags_desc', color: '#43a047' },
        genre: { toggleId: 'genreTagsToggle', settingKey: 'genreTagsEnabled', nameKey: 'panel_settings_ui_tag_group_genre', descKey: 'panel_settings_ui_genre_tags_desc', color: '#00897b' },
        logos: { toggleId: 'logoTagsToggle', settingKey: 'logoTagsEnabled', nameKey: 'panel_settings_ui_tag_group_logos', descKey: 'panel_settings_ui_logo_tags_desc', color: '#5e35b1', capAll: true },
        custom: { toggleId: 'customTagsToggle', settingKey: 'customTagsEnabled', nameKey: 'panel_settings_ui_tag_group_custom', descKey: 'panel_settings_ui_custom_tags_desc', color: '#78909c' },
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
        { id: 'showEditionTagToggle', settingKey: 'showEditionTag', pluginKey: 'ShowEditionTag', orderKey: 'editionTagOrder', orderPluginKey: 'EditionTagOrder', defaultOrder: 7, labelKey: 'panel_settings_ui_quality_tags_edition', sample: null },
        { id: 'showRuntimeTagToggle', settingKey: 'showRuntimeTag', pluginKey: 'ShowRuntimeTag', orderKey: 'runtimeTagOrder', orderPluginKey: 'RuntimeTagOrder', defaultOrder: 8, labelKey: 'panel_settings_ui_quality_tags_runtime', fallback: false, sample: ['1h 52m', '1h 52m', 'other-quality'] },
        { id: 'showAspectRatioTagToggle', settingKey: 'showAspectRatioTag', pluginKey: 'ShowAspectRatioTag', orderKey: 'aspectRatioTagOrder', orderPluginKey: 'AspectRatioTagOrder', defaultOrder: 9, labelKey: 'panel_settings_ui_quality_tags_aspect_ratio', fallback: false, sample: ['2.39:1', '2.39:1', 'other-quality'] },
        { id: 'showFrameRateTagToggle', settingKey: 'showFrameRateTag', pluginKey: 'ShowFrameRateTag', orderKey: 'frameRateTagOrder', orderPluginKey: 'FrameRateTagOrder', defaultOrder: 10, labelKey: 'panel_settings_ui_quality_tags_frame_rate', fallback: false, sample: ['24p', '24p', 'other-quality'] },
    ];

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
     * Resolve a boolean setting: user override, then admin default, then the built-in default.
     * @param {string} userKey
     * @param {string} pluginKey
     * @param {boolean} [fallback=true] - Built-in default.
     * @returns {boolean}
     */
    function effectiveBool(userKey, pluginKey, fallback = true) {
        const u = JE.currentSettings?.[userKey];
        if (typeof u === 'boolean') return u;
        const a = JE.pluginConfig?.[pluginKey];
        return typeof a === 'boolean' ? a : fallback;
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
            canDown: stepCap(cap, -1, meta) !== null,
            canUp: stepCap(cap, 1, meta) !== null,
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
                    <input type="checkbox" id="${c.id}" ${effectiveBool(c.settingKey, c.pluginKey, c.fallback ?? true) ? 'checked' : ''}>
                    <span>${escapeHtml(JE.t(c.labelKey))}</span>
                </label>
                <button type="button" class="je-cat-btn je-cat-up" ${idx === 0 ? 'disabled' : ''} aria-label="${up}"><span class="material-icons" aria-hidden="true">arrow_upward</span></button>
                <button type="button" class="je-cat-btn je-cat-down" ${idx === sorted.length - 1 ? 'disabled' : ''} aria-label="${down}"><span class="material-icons" aria-hidden="true">arrow_downward</span></button>
            </div>`).join('')}
        </div>`;
    }

    /** Ordered source checkboxes and accessible move controls, plus score preferences. */
    function ratingIncludeHtml() {
        const conf = JE.ratingSources.settings();
        const order = conf.sources.concat(JE.ratingSources.IDS.filter(id => !conf.sources.includes(id)));
        return `<div class="je-tge-rating-includes">${order.map((id, index) => {
            const source = JE.t('rating_source_' + id);
            return `<div class="je-rating-source-row" data-source="${id}">
                <label><input type="checkbox" data-rating-source="${id}" ${conf.sources.includes(id) ? 'checked' : ''}>${escapeHtml(source)}</label>
                <button type="button" data-rating-move="-1" ${index === 0 ? 'disabled' : ''} aria-label="${escapeHtml(JE.t('rating_sources_up', { source }))}">↑</button>
                <button type="button" data-rating-move="1" ${index === order.length - 1 ? 'disabled' : ''} aria-label="${escapeHtml(JE.t('rating_sources_down', { source }))}">↓</button>
            </div>`;
        }).join('')}
        <label>${escapeHtml(JE.t('rating_sources_minimum'))} <select data-rating-minimum>${[0,5,6,7,8].map(n => `<option value="${n}" ${conf.minimum === n ? 'selected' : ''}>${n || escapeHtml(JE.t('rating_sources_off'))}</option>`).join('')}</select></label>
        <label><input type="checkbox" data-rating-color ${conf.color ? 'checked' : ''}>${escapeHtml(JE.t('rating_sources_color'))}</label>
        <div class="je-tge-hint">${escapeHtml(JE.t('rating_sources_help'))}</div></div>`;
    }

    /** The language group's track includes and presentation controls. */
    function languageIncludeHtml() {
        const conf = JE.core.languageTags?.readSettings() || {
            audio: effectiveBool('languageTagsShowAudio', 'LanguageTagsShowAudio'),
            subtitles: effectiveBool('languageTagsShowSubtitles', 'LanguageTagsShowSubtitles', false),
            style: 'flags', badge: 'off',
        };
        const select = (key, label, current, values) => `<label class="je-tge-extra"><span class="je-tge-label">${escapeHtml(JE.t(label))}</span>
            <select data-language-key="${key}" style="background:#222;color:#fff;padding:6px;border-radius:6px;">${values.map(([value, text]) => `<option value="${value}" ${value === current ? 'selected' : ''}>${escapeHtml(JE.t(text))}</option>`).join('')}</select></label>`;
        return `<div class="je-tge-includes">${[['Audio', conf.audio], ['Subtitles', conf.subtitles]].map(([kind, on]) => `<label class="je-tge-toggle-pill"><input type="checkbox" data-language-key="languageTagsShow${kind}" ${on ? 'checked' : ''}><span>${escapeHtml(JE.t('language_tags_' + kind.toLowerCase()))}</span></label>`).join('')}</div>
            ${select('languageTagsStyle', 'language_tags_style', conf.style, [['flags', 'language_tags_flags'], ['codes', 'language_tags_codes']])}
            ${select('languageTagsCountBadge', 'language_tags_count_badge', conf.badge, [['off', 'language_tags_badge_off'], ['only', 'language_tags_badge_only'], ['both', 'language_tags_badge_both']])}
            ${languagePriorityHtml()}`;
    }

    /** The personal language priority editor; null choices continue to follow server changes. */
    function languagePriorityHtml() {
        const M = JE.core.mediaLanguage;
        const own = M.priorityList(JE.currentSettings.languageTagsPriority);
        const strict = JE.currentSettings.languageTagsPriorityStrict;
        const policy = M.priorityPolicy();
        return `<fieldset class="je-language-priority">
            <legend class="je-tge-label">${escapeHtml(JE.t('language_priority_title'))}</legend>
            <label><input type="checkbox" data-language-follow ${own === null ? 'checked' : ''}> ${escapeHtml(JE.t('language_priority_follow'))}</label>
            <p class="je-tge-hint">${escapeHtml(JE.t('language_priority_help'))}</p>
            <p class="je-tge-hint" data-language-server>${escapeHtml(JE.t('language_priority_server', { languages: String(JE.pluginConfig?.LanguageTagsPriority || '') || JE.t('language_priority_none') }))}</p>
            <div data-language-personal ${own === null ? 'hidden' : ''}>
                <div class="je-tge-label" data-language-priority-count></div>
                <ol data-language-priority-list></ol>
                <label for="jeLanguagePrioritySearch" class="je-tge-label">${escapeHtml(JE.t('language_priority_search'))}</label>
                <input id="jeLanguagePrioritySearch" type="search" autocomplete="off" maxlength="80" data-language-priority-search>
                <label for="jeLanguagePriorityChoice" class="je-tge-label">${escapeHtml(JE.t('language_priority_language'))}</label>
                <div class="je-language-priority-add">
                    <select id="jeLanguagePriorityChoice" data-language-priority-choice></select>
                    <button type="button" data-language-priority-action="add">${escapeHtml(JE.t('language_priority_add'))}</button>
                </div>
            </div>
            <label for="jeLanguagePriorityStrict" class="je-tge-label">${escapeHtml(JE.t('language_priority_strict'))}</label>
            <select id="jeLanguagePriorityStrict" data-language-priority-strict>
                <option value="inherit" ${typeof strict !== 'boolean' ? 'selected' : ''}>${escapeHtml(JE.t('language_priority_inherit', { policy: JE.t(JE.pluginConfig?.LanguageTagsPriorityStrict ? 'language_priority_only' : 'language_priority_prefer') }))}</option>
                <option value="true" ${strict === true ? 'selected' : ''}>${escapeHtml(JE.t('language_priority_only'))}</option>
                <option value="false" ${strict === false ? 'selected' : ''}>${escapeHtml(JE.t('language_priority_prefer'))}</option>
            </select>
            <span class="je-tge-hint" data-language-priority-status aria-live="polite">${escapeHtml(JE.t(policy.strict ? 'language_priority_only' : 'language_priority_prefer'))}</span>
        </fieldset>`;
    }

    /**
     * Group-specific settings that existed before the editor (sound
     * language, rating scope), kept with their ids. The status badges are
     * the hub's Status badges tab.
     * @param {string} group
     * @param {Object} ctx - Panel context (colours).
     * @returns {string}
     */
    function extrasHtml(group, ctx) {
        const { detailsBackground, toggleAccentColor } = ctx;
        /** @param {string} key @param {string} pluginKey @param {string} id @param {string} labelKey */
        const scopeRow = (id, key, pluginKey, labelKey, fallback = true) => `
            <div class="je-quality-cat-row" data-cat-key="${key}">
                <label class="je-quality-cat-label-wrap">
                    <input type="checkbox" id="${id}" ${effectiveBool(key, pluginKey, fallback) ? 'checked' : ''} style="accent-color:${toggleAccentColor};">
                    <span class="je-quality-cat-label">${escapeHtml(JE.t(labelKey))}</span>
                </label>
            </div>`;
        if (group === 'quality') {
            // "Follow server" is a choice of its own: picking the administrator's
            // policy by name keeps it when the administrator changes theirs.
            const following = JE.isSettingInherited?.(JE.currentSettings, 'seriesQualityAggregation') === true;
            const serverPolicy = JE.inheritedSettingDefault?.(JE.currentSettings, 'seriesQualityAggregation') || 'representative';
            return `
                <div class="je-tge-extra" data-quality-display>
                    <p class="je-tge-hint">${escapeHtml(JE.t('quality_display_help'))}</p>
                    ${['qualityAudioDisplayMode', 'qualityVideoCodecDisplayMode', 'qualityHdrDisplayMode', 'qualityMinimumResolution', 'qualityHideSdr'].map((key, index) => {
                        const labels = ['quality_display_audio', 'quality_display_video', 'quality_display_hdr', 'quality_minimum_resolution', 'quality_hide_sdr'];
                        const options = key === 'qualityMinimumResolution' ? [['off', 'quality_resolution_off'], ['720p', '=720p'], ['1080p', '=1080p'], ['4k', '=4K']]
                            : key === 'qualityHideSdr' ? [['false', 'quality_sdr_show'], ['true', 'quality_sdr_hide']]
                            : [['highest', 'quality_display_highest'], ['all', 'quality_display_all']];
                        const value = JE.isSettingInherited?.(JE.currentSettings, key) || JE.currentSettings[key] == null ? '' : String(JE.currentSettings[key]);
                        return `<label for="${key}Select" class="je-tge-label">${escapeHtml(JE.t(labels[index]))}</label>
                            <select id="${key}Select" data-quality-display-key="${key}" style="width:100%;background:${detailsBackground};color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:6px;padding:6px;">
                                <option value="" ${value === '' ? 'selected' : ''}>${escapeHtml(JE.t('quality_display_inherit'))}</option>
                                ${options.map(([v, label]) => `<option value="${v}" ${value === v ? 'selected' : ''}>${escapeHtml(label.startsWith('=') ? label.slice(1) : JE.t(label))}</option>`).join('')}
                            </select>`;
                    }).join('')}
                </div>
                ${scopeRow('showLowQualitySourceTagToggle', 'showLowQualitySourceTag', 'ShowLowQualitySourceTag', 'panel_settings_ui_quality_tags_low_source', false)}
                <div class="je-tge-extra">
                    <label for="seriesQualityAggregationSelect" class="je-tge-label">${escapeHtml(JE.t('series_quality_aggregation_label'))}</label>
                    <select id="seriesQualityAggregationSelect" style="width:100%; background:${detailsBackground}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:6px; padding:6px;">
                        <option value="" ${following ? 'selected' : ''}>${escapeHtml(JE.t('series_quality_aggregation_inherit', { policy: JE.t('series_quality_aggregation_' + serverPolicy) }))}</option>
                        ${['representative', 'latest', 'best', 'shared', 'mixed'].map(policy => `<option value="${policy}" ${!following && JE.currentSettings.seriesQualityAggregation === policy ? 'selected' : ''}>${escapeHtml(JE.t('series_quality_aggregation_' + policy))}</option>`).join('')}
                    </select>
                </div>
                <div class="je-tge-extra">
                    <button type="button" class="je-tge-reset" id="qualityTagsFollowServer"><span class="material-icons" aria-hidden="true">dns</span><span>${escapeHtml(JE.t('panel_settings_ui_quality_tags_follow_server'))}</span></button>
                    <div class="je-tge-hint">${escapeHtml(JE.t('panel_settings_ui_quality_tags_follow_server_desc'))}</div>
                </div>
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
        else if (group === 'language') include = languageIncludeHtml();
        else if (group === 'status') include = `<div class="je-tge-hint">${escapeHtml(JE.t('panel_media_tags_badges_include'))}</div>`;
        else if (group === 'logos') include = `<div class="je-tge-hint">${escapeHtml(JE.t('panel_settings_ui_logo_tags_include'))}</div>`;
        else if (group === 'custom') {
            // The administrator's rules decide the chips (Configuration > Tags > Custom tags).
            const hasRules = Array.isArray(JE.pluginConfig?.CustomTagRules) && JE.pluginConfig.CustomTagRules.length > 0;
            include = `<div class="je-tge-hint">${escapeHtml(JE.t(hasRules ? 'panel_settings_ui_custom_tags_include' : 'panel_settings_ui_custom_tags_none'))}</div>`;
        }
        else include = `<div class="je-tge-hint">${escapeHtml(JE.t('panel_settings_ui_tag_editor_nothing_to_include'))}</div>`;
        // The Status row opens the hub's Status badges tab (its include list).
        const badges = group === 'status'
            ? `<button type="button" class="je-tge-badges" data-je-goto="badges">${escapeHtml(JE.t('panel_media_tags_badges_link'))}<span class="material-icons" aria-hidden="true">arrow_forward</span></button>`
            : '';
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
                            <span class="je-tge-name" data-je-label>${escapeHtml(name)}</span>
                            <span class="je-tge-summary">${escapeHtml(summaryOf(conf, group))}</span>
                        </span>
                        <span class="material-icons je-tge-chevron" aria-hidden="true">expand_more</span>
                    </button>
                    ${badges}
                    <input type="checkbox" class="je-tge-enable" id="${meta.toggleId}" ${JE.currentSettings?.[meta.settingKey] ? 'checked' : ''} aria-label="${escapeHtml(JE.t('panel_settings_ui_tag_editor_enable', { group: name }))}" style="accent-color:${ctx.toggleAccentColor};">
                </div>
                <div class="je-tge-body" id="${bodyId}" hidden>
                    <div class="je-tge-hint">${escapeHtml(JE.t(meta.descKey))}</div>
                    <div class="je-tge-field" role="group" aria-label="${escapeHtml(JE.t('panel_settings_ui_tag_editor_position'))}">
                        <div class="je-tge-label" aria-hidden="true">${escapeHtml(JE.t('panel_settings_ui_tag_editor_position'))}</div>
                        <div class="je-tge-pills" data-layout="${conf.layout}">${pillsHtml(conf, group)}</div>
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
     * The group editor: its title, the group rows in priority order and the
     * reset button.
     * @param {Object} ctx - Panel context from ui-panel.js.
     * @returns {string}
     */
    internal.buildTagGroupEditorHtml = function(ctx) {
        const { presetBoxBackground, toggleAccentColor } = ctx;
        if (!layoutApi()) return '';
        const conf = readConf();
        const rows = displayOrder(conf).map((group, i) => rowHtml(conf, group, i, ctx)).join('');
        return `
            <div class="je-tge" id="jeTagGroupEditor" style="--je-tge-box:${presetBoxBackground}; --je-tge-accent:${toggleAccentColor};">
                <div class="je-tge-top">
                    <div>
                        <h4 class="je-tge-title" id="jeTgeTitle">${escapeHtml(JE.t('panel_settings_ui_tag_editor_title'))}</h4>
                        <div class="je-tge-hint">${escapeHtml(JE.t('panel_settings_ui_tag_editor_desc'))}</div>
                    </div>
                    <button type="button" class="je-tge-reset" id="jeTgeReset"><span class="material-icons" aria-hidden="true">restart_alt</span><span>${escapeHtml(JE.t('panel_settings_ui_tag_editor_reset'))}</span></button>
                </div>
                <ol class="je-tge-rows" aria-labelledby="jeTgeTitle">${rows}</ol>
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
     * @param {number} cap - Current cap (0 = all).
     * @param {number} dir - +1 or -1.
     * @param {{capFixed?: boolean, capAll?: boolean}} meta - The editor's cap policy.
     * @returns {number|null} Null when the press does nothing.
     */
    function stepCap(cap, dir, meta) {
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
     * Apply the default group editor's cap policy to a stepper press.
     * @param {string} group
     * @param {number} cap
     * @param {number} dir
     * @returns {number|null}
     */
    function nextCap(group, cap, dir) {
        return stepCap(cap, dir, GROUP_META[group]);
    }

    /**
     * Restore the administrator's layout defaults (layout, density, slot
     * profiles, the corner positions, order, caps and edge spacing), as "apply defaults to
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
        JE.currentSettings.tagScale = L.readScale(p.TagScale) || 'default';
        JE.currentSettings.tagGap = L.readGap(p.TagGap) || 'default';
        JE.currentSettings.tagLayouts = copy(p.TagLayouts);
        JE.currentSettings.tagGroupOrder = Array.isArray(p.TagGroupOrder) ? p.TagGroupOrder.slice() : null;
        JE.currentSettings.tagGroupCaps = copy(p.TagGroupCaps);
        JE.currentSettings.tagEdgeSpacing = L.readEdge?.(p.TagEdgeSpacing) || 'default';
        JE.currentSettings.tagLayoutSettingsVersion = 1;
        for (const pos of Object.values(L.POSITION_SETTINGS)) {
            JE.currentSettings[pos.userKey] = p[pos.pluginKey] || pos.fallback;
        }
        saveLayout();
        refillGenres();
    }

    /** CSS for the editor (panel-scoped). */
    const EDITOR_CSS = `
        #jellyfin-enhanced-panel .je-rating-source-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
        #jellyfin-enhanced-panel .je-rating-source-row label { flex: 1; }
        #jellyfin-enhanced-panel .je-rating-source-row button { min-width: 32px; min-height: 32px; color: inherit; background: transparent; border: 1px solid #777; border-radius: 4px; }
        #jellyfin-enhanced-panel .je-tge-rating-includes > label { display: block; margin: 8px 0; }

        #jellyfin-enhanced-panel .je-language-priority { display: flex; flex-direction: column; gap: 8px; min-width: 0; margin: 0; padding: 12px; border: 1px solid #666; border-radius: 6px; }
        #jellyfin-enhanced-panel .je-language-priority [hidden] { display: none; }
        #jellyfin-enhanced-panel .je-language-priority :is(input[type="search"], select) { box-sizing: border-box; width: 100%; min-width: 0; background: #222; color: #fff; border: 1px solid #777; border-radius: 6px; padding: 8px; }
        #jellyfin-enhanced-panel .je-language-priority ol { padding-left: 24px; margin: 6px 0; }
        #jellyfin-enhanced-panel .je-language-priority li { padding: 4px 0; }
        #jellyfin-enhanced-panel .je-language-priority li > div { display: flex; align-items: center; gap: 4px; }
        #jellyfin-enhanced-panel .je-language-priority li span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
        #jellyfin-enhanced-panel .je-language-priority button { min-width: 36px; min-height: 36px; color: inherit; background: transparent; border: 1px solid #777; border-radius: 4px; cursor: pointer; }
        #jellyfin-enhanced-panel .je-language-priority button:disabled { opacity: 0.4; cursor: default; }
        #jellyfin-enhanced-panel .je-language-priority-add { display: flex; gap: 8px; margin-top: 8px; }
        #jellyfin-enhanced-panel .je-language-priority-add select { flex: 1; }

        #jellyfin-enhanced-panel .je-tge { margin-bottom: 16px; padding: 12px; background: var(--je-tge-box); border-radius: 6px; border-left: 3px solid var(--je-tge-accent); }
        #jellyfin-enhanced-panel .je-tge-top { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 12px; }
        #jellyfin-enhanced-panel .je-tge-top > div { flex: 1 1 220px; min-width: 0; }
        #jellyfin-enhanced-panel .je-tge-title { margin: 0; font-size: 15px; font-weight: 600; }
        #jellyfin-enhanced-panel .je-tge-badges { flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px; min-height: 32px; padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.05); color: #fff; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
        #jellyfin-enhanced-panel .je-tge-badges .material-icons { font-size: 16px; }
        #jellyfin-enhanced-panel .je-tge-hint { font-size: 12px; color: rgba(255,255,255,0.6); margin: 2px 0 6px; }
        #jellyfin-enhanced-panel .je-tge-label { font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.75); margin-bottom: 6px; }
        #jellyfin-enhanced-panel .je-tge-reset { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.05); color: #fff; border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; padding: 6px 10px; font: inherit; font-size: 13px; cursor: pointer; }
        #jellyfin-enhanced-panel .je-tge-reset .material-icons { font-size: 18px; }
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
        #jellyfin-enhanced-panel .je-tge-pills[data-layout="corners"] { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
        #jellyfin-enhanced-panel .je-tge-pills[data-layout="corners"] > [data-slot="off"] { grid-column: 1 / -1; }
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
        /* A narrow pane puts Badges on its own line under the Status name, clear of the checkbox. */
        @container je-mth (max-width: 560px) {
            #jellyfin-enhanced-panel .je-tge-row[data-group="status"] .je-tge-row-head { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; row-gap: 4px; }
            #jellyfin-enhanced-panel .je-tge-badges { grid-column: 3; grid-row: 2; justify-self: start; min-height: 40px; }
            #jellyfin-enhanced-panel .je-tge-move, #jellyfin-enhanced-panel .je-tge-step { width: 36px; height: 36px; }
        }
    `;

    /**
     * Wire the editor-owned controls (moves, expand, pills, stepper, rating
     * includes, reset, the Status row's Badges button) and keep the rows in
     * step with the settings after any change, including layout and density
     * changes made on the hub's Layout tab (je:tag-layout-changed). The
     * editor is disposed when the panel closes (ctx.onClose) or is wired again.
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
        let disposed = false;

        const priorityEditor = root.querySelector('.je-language-priority');
        // Standalone/partial editor mounts may contain only layout rows.
        if (priorityEditor) {
            // Choices are built once per panel; searching never requests metadata or lays out cards.
            const priorityChoices = JE.core.mediaLanguage.priorityChoices();
            const priorityNames = new Map(priorityChoices.map(c => [c.code, c.name]));
            let prioritySaving = false;

            /** Filter choices by English name or any equivalent ISO code, excluding selected languages. */
            const filterPriorityChoices = () => {
                const own = JE.core.mediaLanguage.priorityList(JE.currentSettings.languageTagsPriority) || [];
                const query = priorityEditor.querySelector('[data-language-priority-search]').value.trim().toLowerCase();
                /** Exact language names/codes precede family names containing the same word. */
                const exact = c => !!query && [c.name, c.code, ...c.aliases.flatMap(a => a.split(';'))]
                    .some(term => term.trim().toLowerCase() === query);
                const choices = priorityChoices.filter(c => !own.includes(c.code) &&
                    `${c.name} ${c.code} ${c.aliases.join(' ')}`.toLowerCase().includes(query))
                    .sort((a, b) => Number(exact(b)) - Number(exact(a))).slice(0, 40);
                const select = priorityEditor.querySelector('[data-language-priority-choice]');
                const previous = select.value;
                select.replaceChildren(...choices.map(c => {
                    const option = document.createElement('option');
                    option.value = c.code;
                    option.textContent = `${c.name} (${c.code.toUpperCase()})`;
                    return option;
                }));
                if (choices.some(c => c.code === previous)) select.value = previous;
                const full = own.length >= JE.core.mediaLanguage.MAX_PRIORITY_LANGUAGES;
                priorityEditor.querySelector('[data-language-priority-action="add"]').disabled = full || !choices.length;
                select.disabled = full || !choices.length;
            };

            /** Bring the list, inherited choices and count in step with saved or rolled-back settings. */
            const syncPriority = () => {
                const own = JE.core.mediaLanguage.priorityList(JE.currentSettings.languageTagsPriority);
                priorityEditor.querySelector('[data-language-follow]').checked = own === null;
                priorityEditor.querySelector('[data-language-personal]').hidden = own === null;
                priorityEditor.querySelector('[data-language-server]').hidden = own !== null;
                const strict = JE.currentSettings.languageTagsPriorityStrict;
                priorityEditor.querySelector('[data-language-priority-strict]').value = typeof strict === 'boolean' ? String(strict) : 'inherit';
                priorityEditor.querySelector('[data-language-priority-count]').textContent = JE.t('language_priority_count', { count: own?.length || 0 });
                priorityEditor.querySelector('[data-language-priority-list]').innerHTML = (own || []).map((code, i) => {
                    const language = priorityNames.get(code) || code.toUpperCase();
                    return `<li data-language-priority-code="${escapeHtml(code)}"><div><span>${escapeHtml(language)} (${escapeHtml(code.toUpperCase())})</span>
                        <button type="button" data-language-priority-action="up" ${i === 0 ? 'disabled' : ''} aria-label="${escapeHtml(JE.t('language_priority_up', { language }))}">↑</button>
                        <button type="button" data-language-priority-action="down" ${i === own.length - 1 ? 'disabled' : ''} aria-label="${escapeHtml(JE.t('language_priority_down', { language }))}">↓</button>
                        <button type="button" data-language-priority-action="remove" aria-label="${escapeHtml(JE.t('language_priority_remove', { language }))}">×</button>
                    </div></li>`;
                }).join('');
                filterPriorityChoices();
            };

            /**
             * Save just the personal language policy through the normal document transport.
             * Pending priority edits are dropped while the fieldset is disabled. A failed
             * write restores the prior policy inside the shared document save queue.
             * @param {Object} changes
             * @param {{code?: string, action?: string}} [focus]
             */
            const savePriority = async (changes, focus = {}) => {
                if (prioritySaving) return;
                const settings = JE.currentSettings;
                let previous;
                prioritySaving = true;
                priorityEditor.disabled = true;
                touch();
                let failed = false;
                try {
                    await JE.saveUserSettings('settings.json', settings, {
                        throwOnError: true,
                        beforeSave: () => {
                            previous = { languageTagsPriority: settings.languageTagsPriority, languageTagsPriorityStrict: settings.languageTagsPriorityStrict };
                            Object.assign(settings, changes);
                        },
                        onError: () => {
                            if (previous && JE.currentSettings === settings) Object.assign(settings, previous);
                        }
                    });
                } catch {
                    failed = true;
                } finally {
                    prioritySaving = false;
                    priorityEditor.disabled = false;
                }
                if (disposed || JE.currentSettings !== settings || !root.isConnected) return;
                syncPriority();
                if (JE.currentSettings.languageTagsEnabled) JE.reinitializeLanguageTags?.();
                document.dispatchEvent(new CustomEvent('je:tag-layout-changed'));
                priorityEditor.querySelector('[data-language-priority-status]').textContent = JE.t(failed ? 'language_priority_save_failed' : 'language_priority_saved');
                const row = Array.from(priorityEditor.querySelectorAll('[data-language-priority-code]')).find(el => el.dataset.languagePriorityCode === focus.code);
                const target = row?.querySelector(`[data-language-priority-action="${focus.action}"]:not(:disabled)`)
                    || row?.querySelector('button:not(:disabled)')
                    || priorityEditor.querySelector('[data-language-priority-action="add"]:not(:disabled)')
                    || priorityEditor.querySelector('[data-language-follow]');
                if (focus.action) target?.focus();
            };
            priorityEditor.addEventListener('input', e => {
                if (e.target.matches('[data-language-priority-search]')) { filterPriorityChoices(); touch(); }
            });
            priorityEditor.addEventListener('change', e => {
                if (e.target.matches('[data-language-follow]')) savePriority({ languageTagsPriority: e.target.checked ? null : [] });
                if (e.target.matches('[data-language-priority-strict]')) savePriority({ languageTagsPriorityStrict: e.target.value === 'inherit' ? null : e.target.value === 'true' });
            });
            priorityEditor.addEventListener('click', e => {
                const button = e.target.closest('[data-language-priority-action]');
                if (!button || button.disabled || prioritySaving) return;
                const action = button.dataset.languagePriorityAction;
                const own = (JE.core.mediaLanguage.priorityList(JE.currentSettings.languageTagsPriority) || []).slice();
                const row = button.closest('[data-language-priority-code]');
                const code = row?.dataset.languagePriorityCode || priorityEditor.querySelector('[data-language-priority-choice]').value;
                const i = own.indexOf(code);
                if (action === 'add') {
                    if (!code || i !== -1 || own.length >= JE.core.mediaLanguage.MAX_PRIORITY_LANGUAGES) return;
                    own.push(code);
                } else if (action === 'remove') {
                    if (i === -1) return;
                    own.splice(i, 1);
                } else {
                    const to = i + (action === 'up' ? -1 : 1);
                    if (i < 0 || to < 0 || to >= own.length) return;
                    [own[i], own[to]] = [own[to], own[i]];
                }
                savePriority({ languageTagsPriority: own }, { code: action === 'remove' ? own[Math.min(i, own.length - 1)] : code, action });
            });
            syncPriority();
        }

        /** Bring every row (order, summary, pills, stepper, move buttons) in step with the settings. */
        const sync = () => {
            if (disposed || !root.isConnected) return;
            const conf = readConf();
            const order = displayOrder(conf);
            const focusedRow = /** @type {HTMLElement|null} */ (document.activeElement)?.closest?.('.je-tge-row');
            const focused = focusedRow && list.contains(focusedRow) ? /** @type {HTMLElement} */ (document.activeElement) : null;
            for (const group of order) {
                const row = list.querySelector(`.je-tge-row[data-group="${group}"]`);
                if (row && list.lastElementChild !== row) list.appendChild(row);
            }
            // appendChild moves the node, which drops its focus: put it back.
            if (focused && document.activeElement !== focused && focused.isConnected) focused.focus();
            const rows = Array.from(list.querySelectorAll('.je-tge-row'));
            rows.forEach((row, index) => {
                const group = /** @type {HTMLElement} */ (row).dataset.group || '';
                /** @type {HTMLButtonElement} */ (row.querySelector('.je-tge-move[data-dir="up"]')).disabled = index === 0;
                /** @type {HTMLButtonElement} */ (row.querySelector('.je-tge-move[data-dir="down"]')).disabled = index === rows.length - 1;
                /** @type {HTMLElement} */ (row.querySelector('.je-tge-summary')).textContent = summaryOf(conf, group);
                const pills = /** @type {HTMLElement} */ (row.querySelector('.je-tge-pills'));
                const pillFocus = pills.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement).dataset.slot : null;
                pills.dataset.layout = conf.layout;
                pills.innerHTML = pillsHtml(conf, group);
                if (pillFocus) /** @type {HTMLElement|null} */ (pills.querySelector(`[data-slot="${pillFocus}"]`))?.focus();
                const step = stepperState(conf, group);
                /** @type {HTMLElement} */ (row.querySelector('.je-tge-cap')).textContent = step.text;
                /** @type {HTMLButtonElement} */ (row.querySelector('.je-tge-step[data-step="-1"]')).disabled = !step.canDown;
                /** @type {HTMLButtonElement} */ (row.querySelector('.je-tge-step[data-step="1"]')).disabled = !step.canUp;
            });
        };

        /** Persist ordered enabled sources after a toggle or a move, then redraw the real preview. */
        const saveRatings = () => {
            const box = root.querySelector('.je-tge-rating-includes');
            JE.currentSettings.ratingTagsSources = Array.from(box.querySelectorAll('[data-rating-source]:checked')).map(el => el.dataset.ratingSource);
            JE.currentSettings.ratingTagsMinScore = Number(box.querySelector('[data-rating-minimum]').value);
            JE.currentSettings.ratingTagsColorByScore = box.querySelector('[data-rating-color]').checked;
            JE.saveUserSettings('settings.json', JE.currentSettings);
            JE.reinitializeRatingTags?.();
            internal.mediaTagsHub?.refreshPreview?.();
            document.dispatchEvent(new CustomEvent('je:tag-layout-changed'));
            touch();
        };

        root.addEventListener('click', (e) => {
            const target = /** @type {HTMLElement} */ (e.target);
            const sourceMove = target.closest('[data-rating-move]');
            if (sourceMove && !sourceMove.disabled) {
                const sourceRow = sourceMove.closest('[data-source]');
                const before = sourceMove.dataset.ratingMove === '-1' ? sourceRow.previousElementSibling : sourceRow.nextElementSibling;
                if (!before?.matches('[data-source]')) return;
                if (sourceMove.dataset.ratingMove === '-1') before.before(sourceRow); else before.after(sourceRow);
                const rows = Array.from(sourceRow.parentElement.querySelectorAll('[data-source]'));
                rows.forEach((el, i) => { el.querySelector('[data-rating-move="-1"]').disabled = i === 0; el.querySelector('[data-rating-move="1"]').disabled = i === rows.length - 1; });
                saveRatings();
                (sourceMove.disabled ? sourceRow.querySelector('[data-rating-move]:not(:disabled)') : sourceMove)?.focus();
                return;
            }
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
                internal.mediaTagsHub?.announce?.(JE.t('panel_media_tags_group_moved', { group: JE.t(GROUP_META[group].nameKey), n: to + 1 }));
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

            if (target.closest('.je-tge-badges')) {
                internal.mediaTagsHub?.openTab?.('badges', { focus: true });
                touch();
                return;
            }

            const pill = /** @type {HTMLElement|null} */ (target.closest('.je-tge-pill'));
            if (pill && row) {
                writeSlot(readConf().layout, group, pill.dataset.slot || 'off');
                sync();
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
                touch();
                return;
            }

            if (target.closest('#jeTgeReset')) {
                resetToDefaults();
                sync();
                JE.toast(JE.t('toast_tag_layout_reset'));
                touch();
            }
        });

        root.addEventListener('change', (e) => {
            const target = /** @type {HTMLInputElement} */ (e.target);
            if (target.matches('[data-rating-source], [data-rating-minimum], [data-rating-color]')) { saveRatings(); return; }
            const languageKey = target.dataset?.languageKey;
            if (languageKey) {
                JE.currentSettings[languageKey] = target.type === 'checkbox' ? target.checked : target.value;
                JE.saveUserSettings('settings.json', JE.currentSettings);
                if (JE.currentSettings.languageTagsEnabled) JE.reinitializeLanguageTags?.();
                document.dispatchEvent(new CustomEvent('je:tag-layout-changed'));
                touch();
                return;
            }
            const includeKey = target.dataset?.includeKey;
            if (includeKey) {
                JE.currentSettings[includeKey] = target.checked;
                JE.saveUserSettings('settings.json', JE.currentSettings);
                if (JE.currentSettings.ratingTagsEnabled && typeof JE.reinitializeRatingTags === 'function') {
                    JE.reinitializeRatingTags();
                }
                touch();
            }
        });

        // Layout and density are chosen on the hub's Layout tab (and Reset or
        // another tab may change them): re-label the rows for the new layout.
        document.addEventListener('je:tag-layout-changed', sync);

        /** Tear the editor down: stop following layout changes. The panel's markup goes with the panel. */
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            document.removeEventListener('je:tag-layout-changed', sync);
            if (internal.tagGroupEditor === api) internal.tagGroupEditor = null;
        };
        const api = { sync, nextCap, dispose };
        internal.tagGroupEditor = api;
        ctx.onClose?.(dispose);
    };

    // Read by the hub's live preview (ui-panel-tag-preview.js) at draw time.
    internal.tagGroupEditorData = { GROUP_META, QUALITY_CATS, sortedQualityCats, effectiveBool, stepCap };
})(window.JellyfinEnhanced);
