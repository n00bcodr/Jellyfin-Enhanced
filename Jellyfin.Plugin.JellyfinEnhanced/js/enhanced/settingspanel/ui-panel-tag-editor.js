(() => {
"use strict";
(() => {
  // client/src/features/shared/panel-host.ts
  function panelHost() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new TypeError("Jellyfin Enhanced must load before the settings panel");
    return host.JellyfinEnhanced;
  }

  // client/src/features/media-tags/settings/host.ts
  function registry(JE) {
    JE.internals = JE.internals || {};
    return JE.internals.enhancedUi = JE.internals.enhancedUi || {};
  }

  // client/src/features/shared/dom.ts
  function targetElement(event) {
    return event.target instanceof Element ? event.target : null;
  }
  function closestTarget(event, selector) {
    const found = targetElement(event)?.closest(selector);
    return found instanceof HTMLElement ? found : null;
  }
  function queryElement(root, selector) {
    const found = root.querySelector(selector);
    return found instanceof HTMLElement ? found : null;
  }
  function queryInput(root, selector) {
    const found = root.querySelector(selector);
    return found instanceof HTMLInputElement ? found : null;
  }
  function querySelect(root, selector) {
    const found = root.querySelector(selector);
    return found instanceof HTMLSelectElement ? found : null;
  }
  function queryButton(root, selector) {
    const found = root.querySelector(selector);
    return found instanceof HTMLButtonElement ? found : null;
  }
  function queryElements(root, selector) {
    return Array.from(root.querySelectorAll(selector)).filter((node) => node instanceof HTMLElement);
  }
  function setDisabled(node, disabled) {
    if (node instanceof HTMLButtonElement || node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement || node instanceof HTMLFieldSetElement || node instanceof HTMLOptionElement) node.disabled = disabled;
  }
  function isDisabled(node) {
    return (node instanceof HTMLButtonElement || node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement || node instanceof HTMLFieldSetElement || node instanceof HTMLOptionElement) && node.disabled;
  }
  function focusElement(node, options) {
    if (node instanceof HTMLElement || node instanceof SVGElement) node.focus(options);
  }

  // client/src/features/media-tags/settings/tag-caps.ts
  var MAX_CAP = 10;
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
  var clampCap = (cap) => Math.max(0, Math.min(MAX_CAP, cap));

  // client/src/features/shared/settings-values.ts
  function isJson(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJson);
    if (typeof value === "object") return Object.values(value).every(isJson);
    return false;
  }

  // client/src/features/media-tags/settings/ui-panel-tag-editor.ts
  var GROUP_META = {
    awards: { toggleId: "awardsTagsToggle", settingKey: "awardsTagsEnabled", nameKey: "awards_label", descKey: "awards_tags_description", color: "#d7ae52", capAll: true },
    status: { toggleId: "statusTagsToggle", settingKey: "statusTagsEnabled", nameKey: "panel_settings_ui_tag_group_status", descKey: "panel_settings_ui_status_tags_desc", color: "#e53935", capFixed: true },
    quality: { toggleId: "qualityTagsToggle", settingKey: "qualityTagsEnabled", nameKey: "panel_settings_ui_tag_group_quality", descKey: "panel_settings_ui_quality_tags_desc", color: "#1e88e5", capAll: true },
    rating: { toggleId: "ratingTagsToggle", settingKey: "ratingTagsEnabled", nameKey: "panel_settings_ui_tag_group_rating", descKey: "panel_settings_ui_rating_tags_desc", color: "#ffb300", capAll: true },
    ageRating: { toggleId: "ageRatingTagsToggle", settingKey: "ageRatingTagsEnabled", nameKey: "panel_settings_ui_tag_group_age_rating", descKey: "panel_settings_ui_age_rating_tags_desc", color: "#8e24aa", capFixed: true },
    language: { toggleId: "languageTagsToggle", settingKey: "languageTagsEnabled", nameKey: "panel_settings_ui_tag_group_language", descKey: "panel_settings_ui_language_tags_desc", color: "#43a047" },
    genre: { toggleId: "genreTagsToggle", settingKey: "genreTagsEnabled", nameKey: "common_genre", descKey: "panel_settings_ui_genre_tags_desc", color: "#00897b" },
    logos: { toggleId: "logoTagsToggle", settingKey: "logoTagsEnabled", nameKey: "common_logos", descKey: "panel_settings_ui_logo_tags_desc", color: "#5e35b1", capAll: true },
    custom: { toggleId: "customTagsToggle", settingKey: "customTagsEnabled", nameKey: "common_custom", descKey: "panel_settings_ui_custom_tags_desc", color: "#78909c" }
  };
  var GROUP_IDS = ["awards", "status", "quality", "rating", "ageRating", "language", "genre", "logos", "custom"];
  var isGroupId = (value) => typeof value === "string" && GROUP_IDS.some((id) => id === value);
  var LAYOUTS = ["corners", "bands", "caption", "summary", "minimal"];
  var isLayout = (value) => LAYOUTS.some((id) => id === value);
  var QUALITY_CATS = [
    { id: "showResolutionTagToggle", settingKey: "showResolutionTag", pluginKey: "ShowResolutionTag", orderKey: "resolutionTagOrder", orderPluginKey: "ResolutionTagOrder", defaultOrder: 1, labelKey: "panel_settings_ui_quality_tags_resolution", sample: ["4K", "4K", "resolution"] },
    { id: "showSourceTagToggle", settingKey: "showSourceTag", pluginKey: "ShowSourceTag", orderKey: "sourceTagOrder", orderPluginKey: "SourceTagOrder", defaultOrder: 2, labelKey: "panel_settings_ui_quality_tags_source", sample: null },
    { id: "showDynamicRangeTagToggle", settingKey: "showDynamicRangeTag", pluginKey: "ShowDynamicRangeTag", orderKey: "dynamicRangeTagOrder", orderPluginKey: "DynamicRangeTagOrder", defaultOrder: 3, labelKey: "panel_settings_ui_quality_tags_dynamic_range", sample: ["Dolby Vision", "Dolby Vision", "video-codec"] },
    { id: "showSpecialFormatTagToggle", settingKey: "showSpecialFormatTag", pluginKey: "ShowSpecialFormatTag", orderKey: "specialFormatTagOrder", orderPluginKey: "SpecialFormatTagOrder", defaultOrder: 4, labelKey: "panel_settings_ui_quality_tags_special_format", sample: null },
    { id: "showVideoCodecTagToggle", settingKey: "showVideoCodecTag", pluginKey: "ShowVideoCodecTag", orderKey: "videoCodecTagOrder", orderPluginKey: "VideoCodecTagOrder", defaultOrder: 5, labelKey: "panel_settings_ui_quality_tags_video_codec", sample: ["HEVC", "HEVC", "video-format"] },
    { id: "showAudioInfoTagToggle", settingKey: "showAudioInfoTag", pluginKey: "ShowAudioInfoTag", orderKey: "audioInfoTagOrder", orderPluginKey: "AudioInfoTagOrder", defaultOrder: 6, labelKey: "panel_settings_ui_quality_tags_audio_info", sample: ["ATMOS 7.1", "ATMOS", "audio-codec"] },
    { id: "showEditionTagToggle", settingKey: "showEditionTag", pluginKey: "ShowEditionTag", orderKey: "editionTagOrder", orderPluginKey: "EditionTagOrder", defaultOrder: 7, labelKey: "panel_settings_ui_quality_tags_edition", sample: null },
    { id: "showRuntimeTagToggle", settingKey: "showRuntimeTag", pluginKey: "ShowRuntimeTag", orderKey: "runtimeTagOrder", orderPluginKey: "RuntimeTagOrder", defaultOrder: 8, labelKey: "panel_settings_ui_quality_tags_runtime", fallback: false, sample: ["1h 52m", "1h 52m", "other-quality"] },
    { id: "showAspectRatioTagToggle", settingKey: "showAspectRatioTag", pluginKey: "ShowAspectRatioTag", orderKey: "aspectRatioTagOrder", orderPluginKey: "AspectRatioTagOrder", defaultOrder: 9, labelKey: "panel_settings_ui_quality_tags_aspect_ratio", fallback: false, sample: ["2.39:1", "2.39:1", "other-quality"] },
    { id: "showFrameRateTagToggle", settingKey: "showFrameRateTag", pluginKey: "ShowFrameRateTag", orderKey: "frameRateTagOrder", orderPluginKey: "FrameRateTagOrder", defaultOrder: 10, labelKey: "panel_settings_ui_quality_tags_frame_rate", fallback: false, sample: ["24p", "24p", "other-quality"] },
    { id: "showVersionsTagToggle", settingKey: "showVersionsTag", pluginKey: "ShowVersionsTag", orderKey: "versionsTagOrder", orderPluginKey: "VersionsTagOrder", defaultOrder: 11, labelKey: "panel_settings_ui_quality_tags_versions", fallback: false, sample: ["2 versions", "×2", "other-quality"] }
  ];
  var SCOPE_LABELS = {
    movies: "panel_settings_ui_rating_tags_scope_movies",
    series: "panel_settings_ui_rating_tags_scope_series",
    seasons: "panel_settings_ui_rating_tags_scope_seasons",
    episodes: "panel_settings_ui_rating_tags_scope_episodes",
    continueWatching: "panel_settings_ui_rating_tags_scope_continue_watching",
    nextUp: "panel_settings_ui_rating_tags_scope_next_up"
  };
  var QUALITY_DISPLAY_KEYS = ["qualityAudioDisplayMode", "qualityVideoCodecDisplayMode", "qualityHdrDisplayMode", "qualityMinimumResolution", "qualityHideSdr"];
  var QUALITY_DISPLAY_LABELS = ["quality_display_audio", "quality_display_video", "quality_display_hdr", "quality_minimum_resolution", "quality_hide_sdr"];
  function installUiPanelTagEditor(JE) {
    const internal = registry(JE);
    const escapeHtml = (value) => JE.escapeHtml(String(value));
    const t = (key, params) => JE.t(key ?? "", params);
    const layoutApi = () => JE.core?.tagLayout || null;
    const layout = () => {
      const L = layoutApi();
      if (!L) throw new TypeError("The tag layout controller is unavailable");
      return L;
    };
    function readConf() {
      const L = layout();
      L.invalidateSettings();
      return L.normalizeSettings();
    }
    function displayOrder(conf) {
      return (conf.order || layout().DEFAULT_ORDER).slice();
    }
    function slotLabel(layoutId, slot) {
      return slot === "off" ? JE.t("panel_settings_ui_tag_slot_off") : t(layout().VOCABULARY_KEYS.slot[`${layoutId}_${slot}`]);
    }
    function slotsFor(layoutId, group) {
      return layout().LAYOUT_SLOTS[layoutId].filter((slot) => slot !== "dots" || group === "quality");
    }
    function capOf(conf, group) {
      return layout().singleChipGroup(group) ? 1 : conf.caps[group];
    }
    function summaryOf(conf, group) {
      const slot = conf.profiles[conf.layout][group];
      if (slot === "off") return slotLabel(conf.layout, slot);
      const where = slotLabel(conf.layout, slot);
      if (layout().singleChipGroup(group)) return where;
      const cap = capOf(conf, group);
      const count = cap === 0 ? JE.t("panel_settings_ui_tag_editor_summary_all") : JE.t("panel_settings_ui_tag_editor_summary_up_to", { count: cap });
      return `${where} · ${count}`;
    }
    function effectiveBool(userKey, pluginKey, fallback = true) {
      const u = JE.currentSettings?.[userKey];
      if (typeof u === "boolean") return u;
      const a = JE.pluginConfig?.[pluginKey];
      return typeof a === "boolean" ? a : fallback;
    }
    function effectiveCatOrder(cat) {
      const u = JE.currentSettings?.[cat.orderKey];
      if (typeof u === "number" && Number.isFinite(u)) return u;
      const a = JE.pluginConfig?.[cat.orderPluginKey];
      return typeof a === "number" && Number.isFinite(a) ? a : cat.defaultOrder;
    }
    function sortedQualityCats() {
      return QUALITY_CATS.slice().sort((a, b) => effectiveCatOrder(a) - effectiveCatOrder(b) || a.defaultOrder - b.defaultOrder);
    }
    function pillsHtml(conf, group) {
      const current = conf.profiles[conf.layout][group];
      const name = JE.t(GROUP_META[group].nameKey);
      const slots = slotsFor(conf.layout, group);
      const stop = current !== void 0 && slots.includes(current) ? current : slots[0];
      return slots.map((slot) => {
        const label = slotLabel(conf.layout, slot);
        const content = slot === "off" && conf.layout === "corners" ? '<span class="material-icons" aria-hidden="true">visibility_off</span>' : escapeHtml(label);
        return `<button type="button" class="je-tge-pill" data-slot="${slot}" aria-pressed="${slot === current}" tabindex="${slot === stop ? 0 : -1}" aria-label="${escapeHtml(`${name}: ${label}`)}" title="${escapeHtml(label)}">${content}</button>`;
      }).join("");
    }
    function stepperState(conf, group) {
      const meta = GROUP_META[group];
      const cap = capOf(conf, group);
      if (layout().singleChipGroup(group)) return { text: "1", canDown: false, canUp: false };
      return {
        text: cap === 0 ? JE.t("panel_settings_ui_tag_editor_cap_all") : String(cap),
        canDown: stepCap(cap, -1, meta) !== null,
        canUp: stepCap(cap, 1, meta) !== null
      };
    }
    function qualityIncludeHtml() {
      const sorted = sortedQualityCats();
      return `<button type="button" class="je-tge-reset je-tge-reorder" data-tge-reorder="cats" aria-pressed="false"><span class="material-icons" aria-hidden="true">swap_vert</span><span>${escapeHtml(JE.t("panel_settings_ui_tag_editor_reorder_categories"))}</span></button>
        <div id="qualityTagsSubToggles" class="je-tge-cats">${sorted.map((c, idx) => `
            <div class="je-quality-cat-row je-tge-cat" data-cat-key="${c.settingKey}" data-order-key="${c.orderKey}" data-default-order="${c.defaultOrder}">
                <label class="je-tge-toggle-pill">
                    <input type="checkbox" id="${c.id}" ${effectiveBool(c.settingKey, c.pluginKey, c.fallback ?? true) ? "checked" : ""}>
                    <span>${escapeHtml(JE.t(c.labelKey))}</span>
                </label>
                <button type="button" class="je-cat-btn je-cat-up" ${idx === 0 ? "disabled" : ""} aria-label="${escapeHtml(JE.t("panel_settings_ui_quality_tags_move_up_named", { name: JE.t(c.labelKey) }))}"><span class="material-icons" aria-hidden="true">arrow_upward</span></button>
                <button type="button" class="je-cat-btn je-cat-down" ${idx === sorted.length - 1 ? "disabled" : ""} aria-label="${escapeHtml(JE.t("panel_settings_ui_quality_tags_move_down_named", { name: JE.t(c.labelKey) }))}"><span class="material-icons" aria-hidden="true">arrow_downward</span></button>
            </div>`).join("")}
        </div>`;
    }
    const ratingSources = () => {
      const sources = JE.ratingSources;
      if (!sources) throw new TypeError("Rating sources are unavailable");
      return sources;
    };
    function ratingIncludeHtml() {
      const R = ratingSources();
      const conf = R.settings();
      const order = [...conf.sources, ...R.IDS.filter((id) => !conf.sources.includes(id))];
      return `<div class="je-tge-rating-includes">${order.map((id, index) => {
        const source = R.name(id);
        return `<div class="je-rating-source-row" data-source="${id}">
                <label><input type="checkbox" data-rating-source="${id}" ${conf.sources.some((s) => s === id) ? "checked" : ""}>${escapeHtml(source)}</label>
                <button type="button" data-rating-move="-1" ${index === 0 ? "disabled" : ""} aria-label="${escapeHtml(JE.t("rating_sources_up", { source }))}">↑</button>
                <button type="button" data-rating-move="1" ${index === order.length - 1 ? "disabled" : ""} aria-label="${escapeHtml(JE.t("rating_sources_down", { source }))}">↓</button>
            </div>`;
      }).join("")}
        <label>${escapeHtml(JE.t("rating_sources_minimum"))} <select data-rating-minimum>${[0, 5, 6, 7, 8].map((n) => `<option value="${n}" ${conf.minimum === n ? "selected" : ""}>${n || escapeHtml(JE.t("track_off"))}</option>`).join("")}</select></label>
        <label><input type="checkbox" data-rating-color ${conf.color ? "checked" : ""}>${escapeHtml(JE.t("rating_sources_color"))}</label>
        <div class="je-tge-hint">${escapeHtml(JE.t("rating_sources_help"))}</div></div>`;
    }
    function languageIncludeHtml() {
      const conf = JE.core.languageTags?.readSettings() || {
        audio: effectiveBool("languageTagsShowAudio", "LanguageTagsShowAudio"),
        subtitles: effectiveBool("languageTagsShowSubtitles", "LanguageTagsShowSubtitles", false),
        style: "flags",
        badge: "off"
      };
      const select = (key, label, current, values) => `<label class="je-tge-extra"><span class="je-tge-label">${escapeHtml(JE.t(label))}</span>
            <select data-language-key="${key}" style="background:#222;color:#fff;padding:6px;border-radius:6px;">${values.map(([value, text]) => `<option value="${value}" ${value === current ? "selected" : ""}>${escapeHtml(JE.t(text))}</option>`).join("")}</select></label>`;
      const kinds = [["Audio", conf.audio], ["Subtitles", conf.subtitles]];
      return `<div class="je-tge-includes">${kinds.map(([kind, on]) => `<label class="je-tge-toggle-pill"><input type="checkbox" data-language-key="languageTagsShow${kind}" ${on ? "checked" : ""}><span>${escapeHtml(t(layout().VOCABULARY_KEYS.language[kind.toLowerCase()]))}</span></label>`).join("")}</div>
            ${select("languageTagsStyle", "panel_settings_subtitles_style", conf.style, [["flags", "language_tags_flags"], ["codes", "language_tags_codes"]])}
            ${select("languageTagsCountBadge", "language_tags_count_badge", conf.badge, [["off", "track_off"], ["only", "language_tags_badge_only"], ["both", "language_tags_badge_both"]])}
            ${languagePriorityHtml()}`;
    }
    const mediaLanguage = () => {
      const M = JE.core.mediaLanguage;
      if (!M) throw new TypeError("Media language support is unavailable");
      return M;
    };
    function languagePriorityHtml() {
      const M = mediaLanguage();
      const own2 = M.priorityList(JE.currentSettings.languageTagsPriority);
      const strict = JE.currentSettings.languageTagsPriorityStrict;
      const policy = M.priorityPolicy();
      return `<fieldset class="je-language-priority">
            <legend class="je-tge-label">${escapeHtml(JE.t("language_priority_title"))}</legend>
            <label><input type="checkbox" data-language-follow ${own2 === null ? "checked" : ""}> ${escapeHtml(JE.t("language_priority_follow"))}</label>
            <p class="je-tge-hint">${escapeHtml(JE.t("language_priority_help"))}</p>
            <p class="je-tge-hint" data-language-server>${escapeHtml(JE.t("language_priority_server", { languages: String(JE.pluginConfig?.LanguageTagsPriority || "") || JE.t("language_priority_none") }))}</p>
            <div data-language-personal ${own2 === null ? "hidden" : ""}>
                <div class="je-tge-label" data-language-priority-count></div>
                <ol data-language-priority-list></ol>
                <label for="jeLanguagePrioritySearch" class="je-tge-label">${escapeHtml(JE.t("language_priority_search"))}</label>
                <input id="jeLanguagePrioritySearch" type="search" autocomplete="off" maxlength="80" data-language-priority-search>
                <label for="jeLanguagePriorityChoice" class="je-tge-label">${escapeHtml(JE.t("language_priority_language"))}</label>
                <div class="je-language-priority-add">
                    <select id="jeLanguagePriorityChoice" data-language-priority-choice></select>
                    <button type="button" data-language-priority-action="add">${escapeHtml(JE.t("language_priority_add"))}</button>
                </div>
            </div>
            <label for="jeLanguagePriorityStrict" class="je-tge-label">${escapeHtml(JE.t("language_priority_strict"))}</label>
            <select id="jeLanguagePriorityStrict" data-language-priority-strict>
                <option value="inherit" ${typeof strict !== "boolean" ? "selected" : ""}>${escapeHtml(JE.t("language_priority_inherit", { policy: JE.t(JE.pluginConfig?.LanguageTagsPriorityStrict ? "language_priority_only" : "language_priority_prefer") }))}</option>
                <option value="true" ${strict === true ? "selected" : ""}>${escapeHtml(JE.t("language_priority_only"))}</option>
                <option value="false" ${strict === false ? "selected" : ""}>${escapeHtml(JE.t("language_priority_prefer"))}</option>
            </select>
            <span class="je-tge-hint" data-language-priority-status aria-live="polite">${escapeHtml(JE.t(policy.strict ? "language_priority_only" : "language_priority_prefer"))}</span>
        </fieldset>`;
    }
    function scopeBlockHtml(group, ctx) {
      const S = JE.core.tagScopes;
      if (!S) return "";
      const offered = JE.core.tagSettingsMatrix?.offers("hub", group, "scopes") ?? true;
      if (offered !== true) return `<div class="je-tge-extra je-tge-hint" data-je-scope-na="${group}">${escapeHtml(JE.t(offered))}</div>`;
      const rows = S.SCOPE_IDS.map((scope) => {
        const id = group === "rating" ? `ratingTagsOn${scope.charAt(0).toUpperCase()}${scope.slice(1)}Toggle` : `${group}Scope-${scope}`;
        return `<div class="je-quality-cat-row"><label class="je-quality-cat-label-wrap">
                    <input type="checkbox" id="${id}" data-je-scope-group="${group}" data-je-scope="${scope}" ${S.allows(group, scope) ? "checked" : ""} style="accent-color:${ctx.toggleAccentColor};">
                    <span class="je-quality-cat-label">${escapeHtml(t(SCOPE_LABELS[scope]))}</span>
                </label></div>`;
      }).join("");
      const following = S.SCOPE_IDS.every((scope) => S.scopeOwn(group, scope) === null);
      return `
                <div class="je-tge-extra je-tge-scopes" data-je-scope-block="${group}">
                    <div class="je-tge-label je-tge-section" id="${group}ScopeLabel">${escapeHtml(JE.t("tag_scope_label"))}</div>
                    <div class="je-quality-cat-list je-tge-list-box" role="group" aria-labelledby="${group}ScopeLabel"${group === "rating" ? ' id="ratingTagsSubToggles"' : ""}>${rows}</div>
                    <button type="button" class="je-tge-reset" data-je-scope-follow="${group}" ${following ? "disabled" : ""}><span class="material-icons" aria-hidden="true">dns</span><span>${escapeHtml(JE.t(following ? "tag_scope_following" : "tag_scope_follow_server"))}</span></button>
                    <div class="je-tge-hint">${escapeHtml(JE.t("tag_scope_hint"))}</div>
                </div>`;
    }
    function extrasHtml(group, ctx) {
      const { detailsBackground, toggleAccentColor } = ctx;
      const scopeRow = (id, key, pluginKey, labelKey, fallback = true) => `
            <div class="je-quality-cat-row" data-cat-key="${key}">
                <label class="je-quality-cat-label-wrap">
                    <input type="checkbox" id="${id}" ${effectiveBool(key, pluginKey, fallback) ? "checked" : ""} style="accent-color:${toggleAccentColor};">
                    <span class="je-quality-cat-label">${escapeHtml(JE.t(labelKey))}</span>
                </label>
            </div>`;
      if (group === "quality") {
        const following = JE.isSettingInherited?.(JE.currentSettings, "seriesQualityAggregation") === true;
        const serverPolicy = String(JE.inheritedSettingDefault?.(JE.currentSettings, "seriesQualityAggregation") || "representative");
        return `
                <details class="je-tge-more">
                <summary class="je-tge-more-toggle"><span class="material-icons" aria-hidden="true">expand_more</span>${escapeHtml(JE.t("panel_settings_ui_quality_more"))}</summary>
                <div class="je-tge-more-body">
                <div class="je-tge-extra" data-quality-display>
                    <p class="je-tge-hint">${escapeHtml(JE.t("quality_display_help"))}</p>
                    ${QUALITY_DISPLAY_KEYS.map((key, index) => {
          const options = key === "qualityMinimumResolution" ? [["off", "track_off"], ["720p", "=720p"], ["1080p", "=1080p"], ["4k", "=4K"]] : key === "qualityHideSdr" ? [["false", "quality_sdr_show"], ["true", "quality_hide_sdr"]] : [["highest", "quality_display_highest"], ["all", "quality_display_all"]];
          const stored = JE.currentSettings[key];
          const value = JE.isSettingInherited?.(JE.currentSettings, key) || stored == null ? "" : String(stored);
          return `<label for="${key}Select" class="je-tge-label">${escapeHtml(t(QUALITY_DISPLAY_LABELS[index]))}</label>
                            <select id="${key}Select" data-quality-display-key="${key}" style="width:100%;background:${detailsBackground};color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:6px;padding:6px;">
                                <option value="" ${value === "" ? "selected" : ""}>${escapeHtml(JE.t("panel_settings_ui_quality_tags_audio_language_default"))}</option>
                                ${options.map(([v, label]) => `<option value="${v}" ${value === v ? "selected" : ""}>${escapeHtml(label.startsWith("=") ? label.slice(1) : JE.t(label))}</option>`).join("")}
                            </select>`;
        }).join("")}
                </div>
                ${scopeRow("showLowQualitySourceTagToggle", "showLowQualitySourceTag", "ShowLowQualitySourceTag", "panel_settings_ui_quality_tags_low_source", false)}
                <div class="je-tge-extra">
                    <label for="seriesQualityAggregationSelect" class="je-tge-label">${escapeHtml(JE.t("series_quality_aggregation_label"))}</label>
                    <select id="seriesQualityAggregationSelect" style="width:100%; background:${detailsBackground}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:6px; padding:6px;">
                        <option value="" ${following ? "selected" : ""}>${escapeHtml(JE.t("language_priority_inherit", { policy: JE.t("series_quality_aggregation_" + serverPolicy) }))}</option>
                        ${["representative", "latest", "best", "shared", "mixed"].map((policy) => `<option value="${policy}" ${!following && JE.currentSettings.seriesQualityAggregation === policy ? "selected" : ""}>${escapeHtml(JE.t("series_quality_aggregation_" + policy))}</option>`).join("")}
                    </select>
                </div>
                <div class="je-tge-extra">
                    <button type="button" class="je-tge-reset" id="qualityTagsFollowServer"><span class="material-icons" aria-hidden="true">dns</span><span>${escapeHtml(JE.t("panel_settings_ui_quality_tags_follow_server"))}</span></button>
                    <div class="je-tge-hint">${escapeHtml(JE.t("panel_settings_ui_quality_tags_follow_server_desc"))}</div>
                </div>
                <div class="je-quality-audio-lang je-tge-extra">
                    <label for="qualityTagsAudioLanguageSelect" class="je-tge-label">${escapeHtml(JE.t("panel_settings_ui_quality_tags_audio_language"))}</label>
                    <select id="qualityTagsAudioLanguageSelect" style="width:100%; background:${detailsBackground}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:6px; padding:6px;">
                        <option value="">${escapeHtml(JE.t("panel_settings_ui_quality_tags_audio_language_default"))}</option>
                        <option value="auto">${escapeHtml(JE.t("panel_settings_ui_quality_tags_audio_language_auto"))}</option>
                        <option value="none">${escapeHtml(JE.t("panel_settings_ui_quality_tags_audio_language_none"))}</option>
                    </select>
                    <div class="je-tge-hint">${escapeHtml(JE.t("panel_settings_ui_quality_tags_audio_language_desc"))}</div>
                </div>
                </div>
                </details>`;
      }
      return "";
    }
    function rowHtml(conf, group, index, ctx) {
      const meta = GROUP_META[group];
      const name = JE.t(meta.nameKey);
      const step = stepperState(conf, group);
      const bodyId = `jeTgeBody-${group}`;
      let include;
      if (group === "quality") include = qualityIncludeHtml();
      else if (group === "rating") include = ratingIncludeHtml();
      else if (group === "language") include = languageIncludeHtml();
      else if (group === "status") include = `<div class="je-tge-hint">${escapeHtml(JE.t("panel_media_tags_badges_include"))}</div>`;
      else if (group === "logos") include = `<div class="je-tge-hint">${escapeHtml(JE.t("panel_settings_ui_logo_tags_include"))}</div>`;
      else if (group === "awards") include = `<div class="je-tge-hint">${escapeHtml(JE.t("panel_settings_ui_awards_tags_include"))}</div>`;
      else if (group === "custom") {
        const rules = JE.pluginConfig?.CustomTagRules;
        const hasRules = Array.isArray(rules) && rules.length > 0;
        include = `<div class="je-tge-hint">${escapeHtml(JE.t(hasRules ? "panel_settings_ui_custom_tags_include" : "panel_settings_ui_custom_tags_none"))}</div>`;
      } else include = `<div class="je-tge-hint">${escapeHtml(JE.t("panel_settings_ui_tag_editor_nothing_to_include"))}</div>`;
      const badges = group === "status" ? `<button type="button" class="je-tge-badges" data-je-goto="badges">${escapeHtml(JE.t("panel_media_tags_choose_badges"))}<span class="material-icons" aria-hidden="true">arrow_forward</span></button>` : "";
      const single = layout().singleChipGroup(group);
      return `
            <li class="je-tge-row" data-group="${group}" style="--je-tge-swatch:${meta.color};">
                <div class="je-tge-row-head">
                    <div class="je-tge-moves">
                        <button type="button" class="je-tge-move" data-dir="up" ${index === 0 ? "disabled" : ""} aria-label="${escapeHtml(JE.t("panel_settings_ui_tag_editor_move_up", { group: name }))}"><span class="material-icons" aria-hidden="true">arrow_upward</span></button>
                        <button type="button" class="je-tge-move" data-dir="down" ${index === GROUP_IDS.length - 1 ? "disabled" : ""} aria-label="${escapeHtml(JE.t("panel_settings_ui_tag_editor_move_down", { group: name }))}"><span class="material-icons" aria-hidden="true">arrow_downward</span></button>
                    </div>
                    <label class="je-tge-enable-hit"><input type="checkbox" class="je-tge-enable" id="${meta.toggleId}" ${JE.currentSettings?.[meta.settingKey] ? "checked" : ""} aria-label="${escapeHtml(JE.t("panel_settings_ui_tag_editor_enable", { group: name }))}" style="accent-color:${ctx.toggleAccentColor};"></label>
                    <span class="je-tge-swatch" aria-hidden="true"></span>
                    <button type="button" class="je-tge-expand" aria-expanded="false" aria-controls="${bodyId}">
                        <span class="je-tge-text">
                            <span class="je-tge-name" data-je-label>${escapeHtml(name)}</span>
                            <span class="je-tge-summary">${escapeHtml(summaryOf(conf, group))}</span>
                        </span>
                        <span class="material-icons je-tge-chevron" aria-hidden="true">expand_more</span>
                    </button>
                </div>
                <div class="je-tge-body" id="${bodyId}" hidden>
                    <div class="je-tge-hint">${escapeHtml(JE.t(meta.descKey))}</div>
                    ${badges}
                    <div class="je-tge-field" data-je-position role="group" aria-label="${escapeHtml(JE.t("panel_settings_subtitles_position"))}">
                        <div class="je-tge-label je-tge-section" aria-hidden="true">${escapeHtml(JE.t("panel_settings_subtitles_position"))}</div>
                        <div class="je-tge-pills" data-layout="${conf.layout}">${pillsHtml(conf, group)}</div>
                    </div>
                    <div class="je-tge-field" data-je-cap-note ${single ? "" : "hidden"}>
                        <div class="je-tge-label je-tge-section">${escapeHtml(JE.t("panel_settings_ui_tag_editor_show_up_to"))}</div>
                        <div class="je-tge-hint" data-je-limit-na="${group}">${escapeHtml(JE.t("tag_limit_single"))}</div>
                    </div>
                    <div class="je-tge-field" data-je-cap-control ${single ? "hidden" : ""}>
                        <div class="je-tge-label je-tge-section" id="jeTgeCapLabel-${group}">${escapeHtml(JE.t("panel_settings_ui_tag_editor_show_up_to"))}</div>
                        <div class="je-tge-stepper" role="group" aria-labelledby="jeTgeCapLabel-${group}">
                            <button type="button" class="je-tge-step" data-step="-1" ${step.canDown ? "" : "disabled"} aria-label="${escapeHtml(JE.t("panel_settings_ui_tag_editor_cap_decrease", { group: name }))}"><span class="material-icons" aria-hidden="true">remove</span></button>
                            <output class="je-tge-cap" aria-live="polite">${escapeHtml(step.text)}</output>
                            <button type="button" class="je-tge-step" data-step="1" ${step.canUp ? "" : "disabled"} aria-label="${escapeHtml(JE.t("panel_settings_ui_tag_editor_cap_increase", { group: name }))}"><span class="material-icons" aria-hidden="true">add</span></button>
                        </div>
                    </div>
                    <div class="je-tge-field">
                        <div class="je-tge-label je-tge-section">${escapeHtml(JE.t("panel_settings_ui_tag_editor_include"))}</div>
                        ${include}
                    </div>
                    ${scopeBlockHtml(group, ctx)}
                    ${extrasHtml(group, ctx)}
                </div>
            </li>`;
    }
    internal.buildTagGroupEditorHtml = function(ctx) {
      const { presetBoxBackground, toggleAccentColor } = ctx;
      if (!layoutApi()) return "";
      const conf = readConf();
      const rows = displayOrder(conf).map((group, i) => rowHtml(conf, group, i, ctx)).join("");
      return `
            <div class="je-tge" id="jeTagGroupEditor" style="--je-tge-box:${presetBoxBackground}; --je-tge-accent:${toggleAccentColor};">
                <div class="je-tge-top">
                    <div>
                        <h4 class="je-tge-title" id="jeTgeTitle">${escapeHtml(JE.t("panel_settings_ui_tag_editor_title"))}</h4>
                        <div class="je-tge-hint">${escapeHtml(JE.t("panel_settings_ui_tag_editor_desc"))}</div>
                    </div>
                    <button type="button" class="je-tge-reset" id="jeTgeReset"><span class="material-icons" aria-hidden="true">restart_alt</span><span>${escapeHtml(JE.t("panel_settings_ui_tag_editor_reset"))}</span></button>
                    <button type="button" class="je-tge-reset je-tge-reorder" data-tge-reorder="groups" aria-pressed="false"><span class="material-icons" aria-hidden="true">swap_vert</span><span>${escapeHtml(JE.t("panel_settings_ui_tag_editor_reorder_groups"))}</span></button>
                </div>
                <ol class="je-tge-rows" aria-labelledby="jeTgeTitle">${rows}</ol>
            </div>`;
    };
    function promote() {
      layout().promoteLegacySettings(JE.currentSettings);
    }
    function saveLayout() {
      layout().invalidateSettings();
      JE.saveUserSettings("settings.json", JE.currentSettings);
      if (typeof JE.reinitializeTagLayout === "function") JE.reinitializeTagLayout();
    }
    const own = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
    function writeSlot(layoutId, group, slot) {
      const L = layout();
      promote();
      const stored = own(JE.currentSettings.tagLayouts);
      const profiles = stored ? { ...stored } : {};
      const pascal = layoutId.charAt(0).toUpperCase() + layoutId.slice(1);
      const profile = own(profiles[layoutId]) || own(profiles[pascal]) || {};
      const listed = Array.isArray(profile.groups) ? profile.groups : Array.isArray(profile.Groups) ? profile.Groups : [];
      const entries = listed.filter((entry) => {
        const record = own(entry);
        return L.normalizeGroup(record?.group ?? record?.Group) !== group;
      });
      entries.push({ group, slot });
      delete profiles[pascal];
      profiles[layoutId] = { groups: entries };
      JE.currentSettings.tagLayouts = profiles;
      const position = layoutId === "corners" ? L.SLOT_TO_POSITION[slot] : void 0;
      if (position) {
        JE.currentSettings[L.POSITION_SETTINGS[group].userKey] = position;
      }
      saveLayout();
    }
    function writeCap(group, cap) {
      promote();
      const caps = {};
      const stored = own(JE.currentSettings.tagGroupCaps);
      if (stored) {
        for (const [key, value] of Object.entries(stored)) {
          const id = layout().normalizeGroup(key);
          if (id && id !== group) caps[id] = value;
        }
      }
      caps[group] = clampCap(cap);
      JE.currentSettings.tagGroupCaps = caps;
      saveLayout();
      if (group === "genre") refillGenres();
    }
    function refillGenres() {
      if (JE.currentSettings.genreTagsEnabled && typeof JE.reinitializeGenreTags === "function") {
        JE.reinitializeGenreTags();
      }
    }
    function nextCap(group, cap, dir) {
      return layout().singleChipGroup(group) ? null : stepCap(cap, dir, GROUP_META[group]);
    }
    const copy = (value) => {
      if (value === null || typeof value !== "object") return null;
      const cloned = JSON.parse(JSON.stringify(value));
      return isJson(cloned) ? cloned : null;
    };
    function resetToDefaults() {
      promote();
      const L = layout();
      const p = JE.pluginConfig || {};
      const adminLayout = String(p.TagLayout || "").toLowerCase();
      JE.currentSettings.tagLayout = isLayout(adminLayout) ? adminLayout : "corners";
      JE.currentSettings.tagLabelDensity = String(p.TagLabelDensity || "").toLowerCase() === "compact" ? "compact" : "full";
      JE.currentSettings.tagScale = L.readScale(p.TagScale) || "default";
      JE.currentSettings.tagGap = L.readGap(p.TagGap) || "default";
      JE.currentSettings.tagLayouts = copy(p.TagLayouts);
      JE.currentSettings.tagGroupOrder = Array.isArray(p.TagGroupOrder) ? p.TagGroupOrder.slice() : null;
      JE.currentSettings.tagGroupCaps = copy(p.TagGroupCaps);
      JE.currentSettings.tagEdgeSpacing = L.readEdge?.(p.TagEdgeSpacing) || "default";
      JE.currentSettings.tagLayoutSettingsVersion = 1;
      for (const pos of Object.values(L.POSITION_SETTINGS)) {
        JE.currentSettings[pos.userKey] = p[pos.pluginKey] || pos.fallback;
      }
      saveLayout();
      refillGenres();
    }
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

        #jellyfin-enhanced-panel .je-tge { --je-tge-sel: color-mix(in srgb, var(--je-tge-accent) 72%, #000); margin-bottom: 16px; padding: 12px 14px; background: var(--je-tge-box); border-radius: 10px; border: 1px solid rgba(255,255,255,0.1); }
        #jellyfin-enhanced-panel .je-tge-top { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 12px; }
        #jellyfin-enhanced-panel .je-tge-top > div { flex: 1 1 220px; min-width: 0; }
        #jellyfin-enhanced-panel .je-tge-title { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
        #jellyfin-enhanced-panel .je-tge-badges { align-self: flex-start; flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px; min-height: 32px; padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.22); background: rgba(255,255,255,0.06); color: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
        #jellyfin-enhanced-panel .je-tge-badges .material-icons { font-size: 16px; }
        #jellyfin-enhanced-panel .je-tge-hint { font-size: 13px; line-height: 1.45; color: rgba(255,255,255,0.68); margin: 2px 0 6px; }
        #jellyfin-enhanced-panel .je-tge-label { display: block; font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.88); margin-bottom: 6px; }
        #jellyfin-enhanced-panel .je-tge-section { font-size: 11.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: rgba(255,255,255,0.62); margin-bottom: 8px; }
        #jellyfin-enhanced-panel .je-tge-more { border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; }
        #jellyfin-enhanced-panel .je-tge-more-toggle { display: flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 12px 0 8px; font-size: 14px; font-weight: 600; cursor: pointer; list-style: none; border-radius: 8px; }
        #jellyfin-enhanced-panel .je-tge-more-toggle::-webkit-details-marker { display: none; }
        #jellyfin-enhanced-panel .je-tge-more-toggle:hover { background: rgba(255,255,255,0.05); }
        #jellyfin-enhanced-panel .je-tge-more-toggle:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        #jellyfin-enhanced-panel .je-tge-more-toggle .material-icons { font-size: 20px; transition: transform 0.2s ease; }
        #jellyfin-enhanced-panel .je-tge-more[open] > .je-tge-more-toggle .material-icons { transform: rotate(180deg); }
        #jellyfin-enhanced-panel .je-tge-more-body { display: flex; flex-direction: column; gap: 14px; padding: 4px 12px 14px; border-top: 1px solid rgba(255,255,255,0.08); }
        #jellyfin-enhanced-panel .je-tge-extra select { min-height: 40px; }
        #jellyfin-enhanced-panel select option { background: #262626; color: #fff; }
        #jellyfin-enhanced-panel .je-tge-reset { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; min-height: 36px; background: rgba(255,255,255,0.06); color: #fff; border: 1px solid rgba(255,255,255,0.22); border-radius: 6px; padding: 0 12px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
        #jellyfin-enhanced-panel .je-tge-reset .material-icons { font-size: 18px; }
        #jellyfin-enhanced-panel .je-tge-rows { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
        #jellyfin-enhanced-panel .je-tge-row { border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; background: rgba(0,0,0,0.15); }
        #jellyfin-enhanced-panel .je-tge-row:has(.je-tge-expand[aria-expanded="true"]) { border-color: rgba(255,255,255,0.2); background: rgba(255,255,255,0.03); }
        #jellyfin-enhanced-panel .je-tge-row-head { display: flex; align-items: center; gap: 8px; min-height: 48px; box-sizing: border-box; padding: 6px 10px 6px 8px; }
        #jellyfin-enhanced-panel .je-tge-moves { display: flex; gap: 2px; flex-shrink: 0; }
        #jellyfin-enhanced-panel .je-tge-move, #jellyfin-enhanced-panel .je-tge-step { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.46); color: rgba(255,255,255,0.85); border-radius: 6px; width: 32px; height: 32px; padding: 0; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
        #jellyfin-enhanced-panel .je-tge-move .material-icons, #jellyfin-enhanced-panel .je-tge-step .material-icons { font-size: 16px; }
        #jellyfin-enhanced-panel .je-tge-move:disabled, #jellyfin-enhanced-panel .je-tge-step:disabled { opacity: 0.35; cursor: not-allowed; }
        /* The group's colour is an edge bar (a round dot reads as on / off elsewhere). */
        #jellyfin-enhanced-panel .je-tge-swatch { display: none; }
        #jellyfin-enhanced-panel .je-tge-row { border-left: 3px solid var(--je-tge-swatch); }
        #jellyfin-enhanced-panel .je-tge-expand { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; background: transparent; border: 0; color: #fff; text-align: left; padding: 4px; font: inherit; cursor: pointer; border-radius: 4px; }
        #jellyfin-enhanced-panel .je-tge-text { flex: 1; min-width: 0; display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 10px; }
        #jellyfin-enhanced-panel .je-tge-name { font-size: 14px; font-weight: 600; }
        #jellyfin-enhanced-panel .je-tge-summary { font-size: 13px; color: rgba(255,255,255,0.68); }
        #jellyfin-enhanced-panel .je-tge-chevron { flex-shrink: 0; font-size: 20px; transition: transform 0.2s ease; }
        #jellyfin-enhanced-panel .je-tge-expand[aria-expanded="true"] .je-tge-chevron { transform: rotate(180deg); }
        #jellyfin-enhanced-panel .je-tge-enable { width: 18px; height: 18px; margin: 0; flex-shrink: 0; cursor: pointer; }
        /* The switch's own 44px target: it only turns the group on or off (the name opens the row). */
        #jellyfin-enhanced-panel .je-tge-enable-hit { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 44px; height: 44px; margin: -6px 0 -6px -6px; border-radius: 8px; cursor: pointer; }
        #jellyfin-enhanced-panel .je-tge-enable-hit:hover { background: rgba(255,255,255,0.06); }
        #jellyfin-enhanced-panel .je-tge-enable-hit:has(input:focus-visible) { outline: 2px solid #fff; outline-offset: -2px; }
        #jellyfin-enhanced-panel .je-tge .je-tge-enable-hit input:focus-visible { outline: none; }
        /* The group's settings sit in two columns on a wide panel: the position picker on the left, "Show up to" beside it;
           everything else (description, badges, include, where to show) spans the full width. A narrow panel stacks them. */
        #jellyfin-enhanced-panel .je-tge-body { padding: 12px 14px 14px; border-top: 1px solid rgba(255,255,255,0.08); display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 16px 32px; align-items: start; }
        #jellyfin-enhanced-panel .je-tge-body > * { grid-column: 1 / -1; min-width: 0; }
        #jellyfin-enhanced-panel .je-tge-body > .je-tge-field[data-je-position] { grid-column: 1; }
        #jellyfin-enhanced-panel .je-tge-body > .je-tge-field[data-je-cap-note], #jellyfin-enhanced-panel .je-tge-body > .je-tge-field[data-je-cap-control] { grid-column: 2; }
        @media (max-width: 640px) {
            #jellyfin-enhanced-panel .je-tge-body { display: flex; flex-direction: column; }
            #jellyfin-enhanced-panel .je-tge-pills[data-layout="corners"] { margin-right: 0; }
        }
        #jellyfin-enhanced-panel .je-tge-body[hidden] { display: none; }
        /* Corners: the nine positions as a small poster-shaped grid, like the single-corner picker the panel always had:
           a tile per position, the chosen one filled with the accent (each tile's name is its tooltip and accessible
           name); Hidden is a plain button beside it. */
        #jellyfin-enhanced-panel .je-tge-pills[data-layout="corners"] { position: relative; display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(3, 1fr); gap: 3px; box-sizing: border-box; width: 84px; aspect-ratio: 2 / 3; margin-right: 56px; padding: 4px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.3); }
        #jellyfin-enhanced-panel .je-tge-pills[data-layout="corners"] > .je-tge-pill:not([data-slot="off"]) { display: block; width: 100%; height: 100%; min-height: 0; padding: 0; border: 0; border-radius: 3px; background: rgba(255,255,255,0.1); font-size: 0; line-height: 0; color: transparent; transition: background 0.2s; }
        #jellyfin-enhanced-panel .je-tge-pills[data-layout="corners"] > .je-tge-pill:not([data-slot="off"]):hover { background: rgba(255,255,255,0.22); }
        #jellyfin-enhanced-panel .je-tge-pills[data-layout="corners"] > .je-tge-pill:not([data-slot="off"])[aria-pressed="true"] { background: var(--je-tge-sel); }
        #jellyfin-enhanced-panel .je-tge-pills[data-layout="corners"] > .je-tge-pill:not([data-slot="off"]):focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
        #jellyfin-enhanced-panel .je-tge-pills[data-layout="corners"] > [data-slot="off"] { position: absolute; left: calc(100% + 12px); top: 0; width: 40px; min-height: 40px; padding: 0; justify-content: center; border-radius: 8px; font-size: 0; }
        #jellyfin-enhanced-panel .je-tge-pills[data-layout="corners"] > [data-slot="off"] .material-icons { font-size: 22px; line-height: 1; }
        #jellyfin-enhanced-panel .je-tge-pills, #jellyfin-enhanced-panel .je-tge-includes, #jellyfin-enhanced-panel .je-tge-cats { display: flex; flex-wrap: wrap; gap: 6px; }
        #jellyfin-enhanced-panel .je-tge-pill, #jellyfin-enhanced-panel .je-tge-toggle-pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid rgba(255,255,255,0.46); border-radius: 999px; min-height: 32px; box-sizing: border-box; padding: 4px 12px; background: transparent; color: rgba(255,255,255,0.88); font: inherit; font-size: 13px; cursor: pointer; }
        #jellyfin-enhanced-panel :is(.je-tge-pill, .je-tge-toggle-pill):hover { background: rgba(255,255,255,0.06); }
        #jellyfin-enhanced-panel .je-tge-pill[aria-pressed="true"], #jellyfin-enhanced-panel .je-tge-toggle-pill:has(input:checked) { background: var(--je-tge-sel); border-color: var(--je-tge-sel); color: #fff; font-weight: 600; }
        /* Keep the hidden focus target inside its scrolling pill, rather
           than absolutely positioning it against the fixed dialog frame. */
        #jellyfin-enhanced-panel .je-tge-toggle-pill { position: relative; }
        #jellyfin-enhanced-panel .je-tge-toggle-pill input { position: absolute; top: 50%; left: 50%; opacity: 0; width: 1px; height: 1px; margin: 0; }
        #jellyfin-enhanced-panel .je-tge-toggle-pill:has(input:focus-visible) { outline: 2px solid #fff; outline-offset: 2px; }
        #jellyfin-enhanced-panel .je-tge-cat { display: inline-flex; align-items: center; gap: 2px; padding: 0; border: 0; }
        #jellyfin-enhanced-panel .je-tge-cat .je-cat-btn { width: 32px; height: 32px; padding: 0; justify-content: center; }
        #jellyfin-enhanced-panel .je-tge-cat .je-cat-btn .material-icons { font-size: 16px; }
        /* Quality's Include list: an ordered checklist, one category per row with its order buttons at the end. */
        #jellyfin-enhanced-panel .je-tge-cats { flex-direction: column; flex-wrap: nowrap; gap: 0; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; overflow: hidden; }
        #jellyfin-enhanced-panel .je-tge-cats .je-tge-cat { display: flex; align-items: center; gap: 4px; padding: 4px 6px 4px 4px; }
        #jellyfin-enhanced-panel .je-tge-cats .je-tge-cat + .je-tge-cat { border-top: 1px solid rgba(255,255,255,0.07); }
        #jellyfin-enhanced-panel .je-tge-cats .je-tge-toggle-pill, #jellyfin-enhanced-panel .je-tge-cats .je-tge-toggle-pill:has(input:checked) { flex: 1 1 auto; min-width: 0; justify-content: flex-start; gap: 10px; border: 0; border-radius: 6px; padding: 4px 8px; background: transparent; color: #fff; font-weight: 400; }
        #jellyfin-enhanced-panel .je-tge-cats .je-tge-toggle-pill:hover { background: rgba(255,255,255,0.05); }
        #jellyfin-enhanced-panel .je-tge-cats .je-tge-toggle-pill input { position: static; opacity: 1; width: 18px; height: 18px; margin: 0; flex-shrink: 0; accent-color: var(--je-tge-accent); cursor: pointer; }
        #jellyfin-enhanced-panel .je-tge-cats .je-tge-toggle-pill:has(input:not(:checked)) > span { color: rgba(255,255,255,0.68); }
        #jellyfin-enhanced-panel .je-tge-cats .je-tge-toggle-pill:has(input:focus-visible) { outline: none; }
        #jellyfin-enhanced-panel .je-tge-cats .je-tge-toggle-pill input:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        #jellyfin-enhanced-panel [data-je-cap-control][hidden], #jellyfin-enhanced-panel [data-je-cap-note][hidden] { display: none !important; }
        #jellyfin-enhanced-panel .je-tge-stepper { display: inline-flex; align-items: center; gap: 8px; }
        #jellyfin-enhanced-panel .je-tge-cap { min-width: 32px; text-align: center; font-weight: 600; }
        #jellyfin-enhanced-panel .je-tge-list-box { margin: 0; }
        #jellyfin-enhanced-panel .je-tge :is(button, select, input):focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { #jellyfin-enhanced-panel .je-tge-chevron { transition: none; } }
        /* A narrow pane puts Badges on its own line under the Status name, clear of the checkbox. */
        #jellyfin-enhanced-panel .je-tge-reorder { display: none; }
        @container je-mth (max-width: 560px) {
            #jellyfin-enhanced-panel .je-tge-badges, #jellyfin-enhanced-panel .je-tge-reset { min-height: 44px; }
            /* Phone: reordering is its own mode, so the rows give their width to names and summaries. */
            #jellyfin-enhanced-panel .je-tge-reorder { display: inline-flex; min-height: 44px; }
            #jellyfin-enhanced-panel .je-tge-reorder[aria-pressed="true"] { background: rgba(255,255,255,0.12); border-width: 2px; }
            #jellyfin-enhanced-panel .je-tge:not(.je-tge--reorder-groups) .je-tge-moves { display: none; }
            #jellyfin-enhanced-panel .je-tge:not(.je-tge--reorder-cats) .je-tge-cat .je-cat-btn { display: none; }
            #jellyfin-enhanced-panel .je-tge-cats { margin-top: 8px; }
            #jellyfin-enhanced-panel .je-tge-body { padding: 12px 10px 14px; }


            #jellyfin-enhanced-panel .je-tge-expand { min-height: 44px; }
            #jellyfin-enhanced-panel .je-tge-move, #jellyfin-enhanced-panel .je-tge-step, #jellyfin-enhanced-panel .je-tge-cat .je-cat-btn { width: 44px; height: 44px; }
            #jellyfin-enhanced-panel .je-tge-pill, #jellyfin-enhanced-panel .je-tge-toggle-pill, #jellyfin-enhanced-panel .je-tge-pills[data-layout="corners"] > .je-tge-pill { min-height: 44px; }
        }
    `;
    internal.wireTagGroupEditor = function(ctx) {
      internal.tagGroupEditor?.dispose();
      const root = document.getElementById("jeTagGroupEditor");
      const L = layoutApi();
      if (!root || !L) return;
      JE.core.ui?.injectCss?.("je-tag-group-editor", EDITOR_CSS);
      const list = queryElement(root, ".je-tge-rows");
      if (!list) return;
      const touch = () => ctx.resetAutoCloseTimer?.();
      let disposed = false;
      const redrawScopes = (group) => {
        const block = root.querySelector(`[data-je-scope-block="${group}"]`);
        if (block) block.outerHTML = scopeBlockHtml(group, ctx);
        JE.core.tagRenderer?.reinitialize?.(group === "ageRating" ? "agerating" : group);
        document.dispatchEvent(new CustomEvent("je:tag-layout-changed"));
        touch();
      };
      root.addEventListener("change", (e) => {
        const input = e.target;
        if (!(input instanceof HTMLInputElement) || !input.dataset.jeScopeGroup) return;
        const group = input.dataset.jeScopeGroup;
        JE.core.tagScopes?.setOwn(group, input.dataset.jeScope ?? "", input.checked);
        JE.saveUserSettings("settings.json", JE.currentSettings);
        const focusId = input.id;
        if (isGroupId(group)) redrawScopes(group);
        document.getElementById(focusId)?.focus();
      });
      root.addEventListener("click", (e) => {
        const button = closestTarget(e, "[data-je-scope-follow]");
        if (!button || !root.contains(button)) return;
        const group = button.dataset.jeScopeFollow ?? "";
        JE.core.tagScopes?.follow(group);
        JE.saveUserSettings("settings.json", JE.currentSettings);
        if (isGroupId(group)) redrawScopes(group);
        focusElement(root.querySelector(`[data-je-scope-block="${group}"] input`));
      });
      const priorityEditor = root.querySelector(".je-language-priority");
      if (priorityEditor instanceof HTMLFieldSetElement) {
        const M = mediaLanguage();
        const priorityChoices = M.priorityChoices();
        const priorityNames = new Map(priorityChoices.map((c) => [c.code, c.name]));
        let prioritySaving = false;
        const part = (selector, type) => {
          const found = priorityEditor.querySelector(selector);
          if (!(found instanceof type)) throw new TypeError(`Missing language priority control ${selector}`);
          return found;
        };
        const filterPriorityChoices = () => {
          const own2 = M.priorityList(JE.currentSettings.languageTagsPriority) || [];
          const query = part("[data-language-priority-search]", HTMLInputElement).value.trim().toLowerCase();
          const exact = (c) => !!query && [c.name, c.code, ...c.aliases.flatMap((a) => a.split(";"))].some((term) => term.trim().toLowerCase() === query);
          const choices = priorityChoices.filter((c) => !own2.includes(c.code) && `${c.name} ${c.code} ${c.aliases.join(" ")}`.toLowerCase().includes(query)).sort((a, b) => Number(exact(b)) - Number(exact(a))).slice(0, 40);
          const select = part("[data-language-priority-choice]", HTMLSelectElement);
          const previous = select.value;
          select.replaceChildren(...choices.map((c) => {
            const option = document.createElement("option");
            option.value = c.code;
            option.textContent = `${c.name} (${c.code.toUpperCase()})`;
            return option;
          }));
          if (choices.some((c) => c.code === previous)) select.value = previous;
          const full = own2.length >= M.MAX_PRIORITY_LANGUAGES;
          part('[data-language-priority-action="add"]', HTMLButtonElement).disabled = full || !choices.length;
          select.disabled = full || !choices.length;
        };
        const syncPriority = () => {
          const own2 = M.priorityList(JE.currentSettings.languageTagsPriority);
          part("[data-language-follow]", HTMLInputElement).checked = own2 === null;
          part("[data-language-personal]", HTMLElement).hidden = own2 === null;
          part("[data-language-server]", HTMLElement).hidden = own2 !== null;
          const strict = JE.currentSettings.languageTagsPriorityStrict;
          part("[data-language-priority-strict]", HTMLSelectElement).value = typeof strict === "boolean" ? String(strict) : "inherit";
          part("[data-language-priority-count]", HTMLElement).textContent = JE.t("language_priority_count", { count: own2?.length || 0 });
          part("[data-language-priority-list]", HTMLElement).innerHTML = (own2 || []).map((code, i) => {
            const language = priorityNames.get(code) || code.toUpperCase();
            return `<li data-language-priority-code="${escapeHtml(code)}"><div><span>${escapeHtml(language)} (${escapeHtml(code.toUpperCase())})</span>
                        <button type="button" data-language-priority-action="up" ${i === 0 ? "disabled" : ""} aria-label="${escapeHtml(JE.t("language_priority_up", { language }))}">↑</button>
                        <button type="button" data-language-priority-action="down" ${i === (own2?.length ?? 0) - 1 ? "disabled" : ""} aria-label="${escapeHtml(JE.t("language_priority_down", { language }))}">↓</button>
                        <button type="button" data-language-priority-action="remove" aria-label="${escapeHtml(JE.t("language_priority_remove", { language }))}">×</button>
                    </div></li>`;
          }).join("");
          filterPriorityChoices();
        };
        const savePriority = async (changes, focus = {}) => {
          if (prioritySaving) return;
          const settings = JE.currentSettings;
          const isCurrent = JE.core.tagLook?.captureSession?.();
          let previous;
          prioritySaving = true;
          priorityEditor.disabled = true;
          touch();
          let failed = false;
          try {
            await JE.saveUserSettings("settings.json", settings, {
              throwOnError: true,
              ...isCurrent ? { isCurrent } : {},
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
          document.dispatchEvent(new CustomEvent("je:tag-layout-changed"));
          part("[data-language-priority-status]", HTMLElement).textContent = JE.t(failed ? "language_priority_save_failed" : "language_priority_saved");
          const row = queryElements(priorityEditor, "[data-language-priority-code]").find((el) => el.dataset.languagePriorityCode === focus.code);
          const target = row?.querySelector(`[data-language-priority-action="${focus.action}"]:not(:disabled)`) || row?.querySelector("button:not(:disabled)") || priorityEditor.querySelector('[data-language-priority-action="add"]:not(:disabled)') || priorityEditor.querySelector("[data-language-follow]");
          if (focus.action) focusElement(target);
        };
        priorityEditor.addEventListener("input", (e) => {
          if (targetElement(e)?.matches("[data-language-priority-search]")) {
            filterPriorityChoices();
            touch();
          }
        });
        priorityEditor.addEventListener("change", (e) => {
          const target = e.target;
          if (target instanceof HTMLInputElement && target.matches("[data-language-follow]")) savePriority({ languageTagsPriority: target.checked ? null : [] });
          if (target instanceof HTMLSelectElement && target.matches("[data-language-priority-strict]")) savePriority({ languageTagsPriorityStrict: target.value === "inherit" ? null : target.value === "true" });
        });
        priorityEditor.addEventListener("click", (e) => {
          const button = closestTarget(e, "[data-language-priority-action]");
          if (!button || isDisabled(button) || prioritySaving) return;
          const action = button.dataset.languagePriorityAction;
          const own2 = (M.priorityList(JE.currentSettings.languageTagsPriority) || []).slice();
          const row = button.closest("[data-language-priority-code]");
          const code = (row instanceof HTMLElement ? row.dataset.languagePriorityCode : void 0) || part("[data-language-priority-choice]", HTMLSelectElement).value;
          const i = own2.indexOf(code);
          if (action === "add") {
            if (!code || i !== -1 || own2.length >= M.MAX_PRIORITY_LANGUAGES) return;
            own2.push(code);
          } else if (action === "remove") {
            if (i === -1) return;
            own2.splice(i, 1);
          } else {
            const to = i + (action === "up" ? -1 : 1);
            const here = own2[i], there = own2[to];
            if (i < 0 || to < 0 || to >= own2.length || here === void 0 || there === void 0) return;
            own2[i] = there;
            own2[to] = here;
          }
          savePriority({ languageTagsPriority: own2 }, { code: action === "remove" ? own2[Math.min(i, own2.length - 1)] : code, action });
        });
        syncPriority();
      }
      const sync = () => {
        if (disposed || !root.isConnected) return;
        const conf = readConf();
        const order = displayOrder(conf);
        const active = document.activeElement;
        const focusedRow = active?.closest?.(".je-tge-row");
        const focused = focusedRow && list.contains(focusedRow) && active instanceof HTMLElement ? active : null;
        let previous = null;
        for (const group of order) {
          const row = list.querySelector(`.je-tge-row[data-group="${group}"]`);
          if (!row) continue;
          const expected = previous ? previous.nextElementSibling : list.firstElementChild;
          if (row !== expected) list.insertBefore(row, expected);
          previous = row;
        }
        if (focused && document.activeElement !== focused && focused.isConnected) focused.focus({ preventScroll: true });
        const rows = queryElements(list, ".je-tge-row");
        rows.forEach((row, index) => {
          const group = row.dataset.group;
          if (!isGroupId(group)) return;
          setDisabled(row.querySelector('.je-tge-move[data-dir="up"]'), index === 0);
          setDisabled(row.querySelector('.je-tge-move[data-dir="down"]'), index === rows.length - 1);
          const summary = row.querySelector(".je-tge-summary");
          if (summary) summary.textContent = summaryOf(conf, group);
          const pills = queryElement(row, ".je-tge-pills");
          if (pills) {
            const focusedPill = document.activeElement;
            const pillFocus = focusedPill instanceof HTMLElement && pills.contains(focusedPill) ? focusedPill.dataset.slot : null;
            pills.dataset.layout = conf.layout;
            pills.innerHTML = pillsHtml(conf, group);
            if (pillFocus) focusElement(pills.querySelector(`[data-slot="${pillFocus}"]`));
          }
          const capControl = queryElement(row, "[data-je-cap-control]");
          if (capControl) capControl.hidden = layout().singleChipGroup(group);
          const capNote = queryElement(row, "[data-je-cap-note]");
          if (capNote) capNote.hidden = !layout().singleChipGroup(group);
          const step = stepperState(conf, group);
          const cap = row.querySelector(".je-tge-cap");
          if (cap) cap.textContent = step.text;
          setDisabled(row.querySelector('.je-tge-step[data-step="-1"]'), !step.canDown);
          setDisabled(row.querySelector('.je-tge-step[data-step="1"]'), !step.canUp);
        });
      };
      const saveRatings = () => {
        const box = root.querySelector(".je-tge-rating-includes");
        if (!box) return;
        JE.currentSettings.ratingTagsSources = queryElements(box, "[data-rating-source]:checked").map((el) => el.dataset.ratingSource ?? "");
        JE.currentSettings.ratingTagsMinScore = Number(querySelect(box, "[data-rating-minimum]")?.value);
        JE.currentSettings.ratingTagsColorByScore = queryInput(box, "[data-rating-color]")?.checked;
        JE.saveUserSettings("settings.json", JE.currentSettings);
        JE.reinitializeRatingTags?.();
        internal.mediaTagsHub?.refreshPreview?.();
        document.dispatchEvent(new CustomEvent("je:tag-layout-changed"));
        touch();
      };
      root.addEventListener("keydown", (e) => {
        const pill = closestTarget(e, ".je-tge-pills .je-tge-pill");
        if (!pill || !pill.parentElement || e.altKey || e.ctrlKey || e.metaKey) return;
        const pills = queryElements(pill.parentElement, ".je-tge-pill");
        const at = pills.indexOf(pill);
        const keySteps = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
        const step = Object.prototype.hasOwnProperty.call(keySteps, e.key) ? keySteps[e.key] : void 0;
        const next = step ? pills[(at + step + pills.length) % pills.length] : e.key === "Home" ? pills[0] : e.key === "End" ? pills[pills.length - 1] : null;
        if (!next) return;
        e.preventDefault();
        pills.forEach((p) => {
          p.tabIndex = p === next ? 0 : -1;
        });
        next.focus();
      });
      root.addEventListener("click", (e) => {
        const target = targetElement(e);
        if (!target) return;
        const sourceMove = closestTarget(e, "[data-rating-move]");
        if (sourceMove && !isDisabled(sourceMove)) {
          const sourceRow = sourceMove.closest("[data-source]");
          if (!sourceRow) return;
          const before = sourceMove.dataset.ratingMove === "-1" ? sourceRow.previousElementSibling : sourceRow.nextElementSibling;
          if (!before?.matches("[data-source]")) return;
          if (sourceMove.dataset.ratingMove === "-1") before.before(sourceRow);
          else before.after(sourceRow);
          const rows = sourceRow.parentElement ? Array.from(sourceRow.parentElement.querySelectorAll("[data-source]")) : [];
          rows.forEach((el, i) => {
            setDisabled(el.querySelector('[data-rating-move="-1"]'), i === 0);
            setDisabled(el.querySelector('[data-rating-move="1"]'), i === rows.length - 1);
          });
          saveRatings();
          focusElement(isDisabled(sourceMove) ? sourceRow.querySelector("[data-rating-move]:not(:disabled)") : sourceMove);
          return;
        }
        const row = closestTarget(e, ".je-tge-row");
        const rowGroup = row?.dataset.group;
        const group = isGroupId(rowGroup) ? rowGroup : null;
        const move = closestTarget(e, ".je-tge-move");
        if (move && row && !isDisabled(move)) {
          const order = displayOrder(readConf());
          const from = group ? order.indexOf(group) : -1;
          const to = from + (move.dataset.dir === "up" ? -1 : 1);
          if (!group || from < 0 || to < 0 || to >= order.length) return;
          order.splice(to, 0, ...order.splice(from, 1));
          promote();
          JE.currentSettings.tagGroupOrder = order;
          saveLayout();
          sync();
          const same = queryButton(row, `.je-tge-move[data-dir="${move.dataset.dir}"]`);
          focusElement(same?.disabled ? row.querySelector(".je-tge-move:not(:disabled)") : same);
          internal.mediaTagsHub?.announce?.(JE.t("panel_media_tags_group_moved", { group: JE.t(GROUP_META[group].nameKey), n: to + 1 }));
          touch();
          return;
        }
        const expand = closestTarget(e, ".je-tge-expand");
        if (expand && row) {
          const open = expand.getAttribute("aria-expanded") !== "true";
          expand.setAttribute("aria-expanded", String(open));
          const body = queryElement(row, ".je-tge-body");
          if (body) body.hidden = !open;
          touch();
          return;
        }
        if (target.closest(".je-tge-badges")) {
          internal.mediaTagsHub?.openTab?.("badges", { focus: true });
          touch();
          return;
        }
        const pill = closestTarget(e, ".je-tge-pill");
        if (pill && row) {
          if (group) writeSlot(readConf().layout, group, pill.dataset.slot || "off");
          sync();
          touch();
          return;
        }
        const step = closestTarget(e, ".je-tge-step");
        if (step && row && !isDisabled(step)) {
          const next = group ? nextCap(group, capOf(readConf(), group), Number(step.dataset.step)) : null;
          if (group && next !== null) writeCap(group, next);
          sync();
          if (isDisabled(step)) focusElement(row.querySelector(".je-tge-step:not(:disabled)"));
          touch();
          return;
        }
        const reorder = closestTarget(e, "[data-tge-reorder]");
        if (reorder) {
          const kind = reorder.dataset.tgeReorder;
          const on = !root.classList.contains(`je-tge--reorder-${kind}`);
          root.classList.toggle(`je-tge--reorder-${kind}`, on);
          root.querySelectorAll(`[data-tge-reorder="${kind}"]`).forEach((b) => {
            b.setAttribute("aria-pressed", String(on));
            const label = b.lastElementChild;
            if (label) label.textContent = JE.t(on ? "panel_settings_ui_tag_editor_reorder_done" : kind === "groups" ? "panel_settings_ui_tag_editor_reorder_groups" : "panel_settings_ui_tag_editor_reorder_categories");
          });
          return;
        }
        if (target.closest("#jeTgeReset")) {
          resetToDefaults();
          sync();
          JE.toast(JE.t("toast_tag_layout_reset"));
          touch();
        }
      });
      root.addEventListener("change", (e) => {
        const target = e.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.matches("[data-rating-source], [data-rating-minimum], [data-rating-color]")) {
          saveRatings();
          return;
        }
        const languageKey = target.dataset?.languageKey;
        if (languageKey) {
          JE.currentSettings[languageKey] = target instanceof HTMLInputElement && target.type === "checkbox" ? target.checked : target instanceof HTMLInputElement || target instanceof HTMLSelectElement ? target.value : void 0;
          JE.saveUserSettings("settings.json", JE.currentSettings);
          if (JE.currentSettings.languageTagsEnabled) JE.reinitializeLanguageTags?.();
          document.dispatchEvent(new CustomEvent("je:tag-layout-changed"));
          touch();
          return;
        }
        const includeKey = target.dataset?.includeKey;
        if (includeKey) {
          JE.currentSettings[includeKey] = target instanceof HTMLInputElement ? target.checked : void 0;
          JE.saveUserSettings("settings.json", JE.currentSettings);
          if (JE.currentSettings.ratingTagsEnabled && typeof JE.reinitializeRatingTags === "function") {
            JE.reinitializeRatingTags();
          }
          touch();
        }
      });
      document.addEventListener("je:tag-layout-changed", sync);
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        document.removeEventListener("je:tag-layout-changed", sync);
        if (internal.tagGroupEditor === api) internal.tagGroupEditor = null;
      };
      const api = { sync, nextCap, dispose };
      internal.tagGroupEditor = api;
      ctx.onClose?.(dispose);
    };
    const editorData = { GROUP_META, QUALITY_CATS, sortedQualityCats, effectiveBool, stepCap };
    internal.tagGroupEditorData = editorData;
  }
  installUiPanelTagEditor(panelHost());
})();
})();
//# sourceMappingURL=ui-panel-tag-editor.js.map
