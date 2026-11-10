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
import type { JsonValue } from '../../../contracts/generated';
import type { Group, Layout, LayoutSettings } from '../layout/layout-rules';
import { panelHost, registry, type PanelBridge, type PanelTagLayout } from './host';
import type { PanelContext } from '../../settings-panel/public-api';
import { closestTarget, focusElement, isDisabled, queryButton, queryElement, queryElements, queryInput, querySelect, setDisabled, targetElement } from '../../shared/dom';
import { clampCap, stepCap, type CapPolicy } from './tag-caps';
import { isJson } from '../../shared/settings-values';

type Deps = Pick<PanelBridge, 'internals' | 'core' | 'currentSettings' | 'pluginConfig' | 't' | 'escapeHtml' | 'ratingSources'
    | 'saveUserSettings' | 'toast' | 'isSettingInherited' | 'inheritedSettingDefault' | 'reinitializeTagLayout' | 'reinitializeGenreTags'
    | 'reinitializeLanguageTags' | 'reinitializeRatingTags'>;
type EditorContext = Pick<PanelContext, 'presetBoxBackground' | 'toggleAccentColor' | 'detailsBackground'>;
type WireContext = Partial<Pick<PanelContext, 'resetAutoCloseTimer' | 'onClose'>> & EditorContext;

/**
 * Per group: its enable toggle (id and setting key, unchanged), the panel's
 * name and description strings, the swatch colour, and its cap rule.
 */
export interface GroupMeta extends CapPolicy { toggleId: string; settingKey: string; nameKey: string; descKey: string; color: string }
export const GROUP_META: Readonly<Record<Group, GroupMeta>> = {
    awards: { toggleId: 'awardsTagsToggle', settingKey: 'awardsTagsEnabled', nameKey: 'awards_label', descKey: 'awards_tags_description', color: '#d7ae52', capAll: true },
    status: { toggleId: 'statusTagsToggle', settingKey: 'statusTagsEnabled', nameKey: 'panel_settings_ui_tag_group_status', descKey: 'panel_settings_ui_status_tags_desc', color: '#e53935', capFixed: true },
    quality: { toggleId: 'qualityTagsToggle', settingKey: 'qualityTagsEnabled', nameKey: 'panel_settings_ui_tag_group_quality', descKey: 'panel_settings_ui_quality_tags_desc', color: '#1e88e5', capAll: true },
    rating: { toggleId: 'ratingTagsToggle', settingKey: 'ratingTagsEnabled', nameKey: 'panel_settings_ui_tag_group_rating', descKey: 'panel_settings_ui_rating_tags_desc', color: '#ffb300', capAll: true },
    ageRating: { toggleId: 'ageRatingTagsToggle', settingKey: 'ageRatingTagsEnabled', nameKey: 'panel_settings_ui_tag_group_age_rating', descKey: 'panel_settings_ui_age_rating_tags_desc', color: '#8e24aa', capFixed: true },
    language: { toggleId: 'languageTagsToggle', settingKey: 'languageTagsEnabled', nameKey: 'panel_settings_ui_tag_group_language', descKey: 'panel_settings_ui_language_tags_desc', color: '#43a047' },
    genre: { toggleId: 'genreTagsToggle', settingKey: 'genreTagsEnabled', nameKey: 'common_genre', descKey: 'panel_settings_ui_genre_tags_desc', color: '#00897b' },
    logos: { toggleId: 'logoTagsToggle', settingKey: 'logoTagsEnabled', nameKey: 'common_logos', descKey: 'panel_settings_ui_logo_tags_desc', color: '#5e35b1', capAll: true },
    custom: { toggleId: 'customTagsToggle', settingKey: 'customTagsEnabled', nameKey: 'common_custom', descKey: 'panel_settings_ui_custom_tags_desc', color: '#78909c' },
};
/** The groups in GROUP_META's declaration order. */
const GROUP_IDS: readonly Group[] = ['awards', 'status', 'quality', 'rating', 'ageRating', 'language', 'genre', 'logos', 'custom'];
const isGroupId = (value: unknown): value is Group => typeof value === 'string' && GROUP_IDS.some(id => id === value);
const LAYOUTS: readonly Layout[] = ['corners', 'bands', 'caption', 'summary', 'minimal'];
const isLayout = (value: string): value is Layout => LAYOUTS.some(id => id === value);

/** A quality category: toggle/order keys (as the panel always had them) and the preview's sample chip. */
export interface QualityCat {
    id: string; settingKey: string; pluginKey: string; orderKey: string; orderPluginKey: string; defaultOrder: number;
    labelKey: string; fallback?: boolean; sample: readonly [string, string, string] | null;
}
export const QUALITY_CATS: readonly QualityCat[] = [
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
    { id: 'showVersionsTagToggle', settingKey: 'showVersionsTag', pluginKey: 'ShowVersionsTag', orderKey: 'versionsTagOrder', orderPluginKey: 'VersionsTagOrder', defaultOrder: 11, labelKey: 'panel_settings_ui_quality_tags_versions', fallback: false, sample: ['2 versions', '×2', 'other-quality'] },
];

const SCOPE_LABELS: Readonly<Record<string, string>> = { movies: 'panel_settings_ui_rating_tags_scope_movies', series: 'panel_settings_ui_rating_tags_scope_series',
    seasons: 'panel_settings_ui_rating_tags_scope_seasons', episodes: 'panel_settings_ui_rating_tags_scope_episodes',
    continueWatching: 'panel_settings_ui_rating_tags_scope_continue_watching', nextUp: 'panel_settings_ui_rating_tags_scope_next_up' };
const QUALITY_DISPLAY_KEYS = ['qualityAudioDisplayMode', 'qualityVideoCodecDisplayMode', 'qualityHdrDisplayMode', 'qualityMinimumResolution', 'qualityHideSdr'] as const;
const QUALITY_DISPLAY_LABELS = ['quality_display_audio', 'quality_display_video', 'quality_display_hdr', 'quality_minimum_resolution', 'quality_hide_sdr'] as const;

/** What the hub's preview and the admin Media Tags page read from the editor (internal.tagGroupEditorData). */
export interface TagGroupEditorData {
    GROUP_META: Readonly<Record<Group, GroupMeta>>;
    QUALITY_CATS: readonly QualityCat[];
    sortedQualityCats(): QualityCat[];
    effectiveBool(userKey: string, pluginKey: string, fallback?: boolean): boolean;
    stepCap(cap: number, dir: number, meta: CapPolicy): number | null;
}
/** The open editor (internal.tagGroupEditor). */
export interface TagGroupEditorApi { sync(): void; nextCap(group: Group, cap: number, dir: number): number | null; dispose(): void }

export function installUiPanelTagEditor(JE: Deps): void {
    const internal = registry(JE);

    const escapeHtml = (value: unknown) => JE.escapeHtml(String(value));
    const t = (key: string | undefined, params?: Record<string, string | number>) => JE.t(key ?? '', params);

    /** The layout controller (core/tag-layout.js), or null. */
    const layoutApi = (): PanelTagLayout | null => JE.core?.tagLayout || null;
    /** The controller for code that runs only once the editor exists (legacy dereferenced it). */
    const layout = (): PanelTagLayout => {
        const L = layoutApi();
        if (!L) throw new TypeError('The tag layout controller is unavailable');
        return L;
    };

    /** Effective layout settings, read fresh (the controller memoises them). */
    function readConf(): LayoutSettings {
        const L = layout();
        L.invalidateSettings();
        return L.normalizeSettings();
    }

    /**
     * The order the rows show: the effective order, or the default one for
     * documents that still use arrival order (written on the first move).
     */
    function displayOrder(conf: LayoutSettings): Group[] {
        return (conf.order || layout().DEFAULT_ORDER).slice();
    }

    /** Label of a slot in a layout ("Bottom row"), or "Hidden" for off. */
    function slotLabel(layoutId: Layout, slot: string | undefined): string {
        return slot === 'off'
            ? JE.t('panel_settings_ui_tag_slot_off')
            : t(layout().VOCABULARY_KEYS.slot[`${layoutId}_${slot}`]);
    }

    /** Slots a group may use in a layout (the minimal layout's dots are quality only). */
    function slotsFor(layoutId: Layout, group: Group): string[] {
        return layout().LAYOUT_SLOTS[layoutId].filter((slot) => slot !== 'dots' || group === 'quality');
    }

    /** The cap a group shows in the stepper (0 = all). */
    function capOf(conf: LayoutSettings, group: Group): number {
        return layout().singleChipGroup(group) ? 1 : conf.caps[group];
    }

    /** One-line row summary: "Bottom row · up to 3", "Top left · all tags", "Hidden". */
    function summaryOf(conf: LayoutSettings, group: Group): string {
        const slot = conf.profiles[conf.layout][group];
        if (slot === 'off') return slotLabel(conf.layout, slot);
        const where = slotLabel(conf.layout, slot);
        if (layout().singleChipGroup(group)) return where;
        const cap = capOf(conf, group);
        const count = cap === 0
            ? JE.t('panel_settings_ui_tag_editor_summary_all')
            : JE.t('panel_settings_ui_tag_editor_summary_up_to', { count: cap });
        return `${where} · ${count}`;
    }

    /** Resolve a boolean setting: user override, then admin default, then the built-in default. */
    function effectiveBool(userKey: string, pluginKey: string, fallback = true): boolean {
        const u = JE.currentSettings?.[userKey];
        if (typeof u === 'boolean') return u;
        const a = JE.pluginConfig?.[pluginKey];
        return typeof a === 'boolean' ? a : fallback;
    }

    /** Effective stack order of a quality category (user → admin → built-in). */
    function effectiveCatOrder(cat: QualityCat): number {
        const u = JE.currentSettings?.[cat.orderKey];
        if (typeof u === 'number' && Number.isFinite(u)) return u;
        const a = JE.pluginConfig?.[cat.orderPluginKey];
        return typeof a === 'number' && Number.isFinite(a) ? a : cat.defaultOrder;
    }

    /** The quality categories in their effective stack order. */
    function sortedQualityCats(): QualityCat[] {
        return QUALITY_CATS.slice().sort((a, b) => (effectiveCatOrder(a) - effectiveCatOrder(b)) || (a.defaultOrder - b.defaultOrder));
    }

    // ── Markup ─────────────────────────────────────────────────────────

    /** Position pills for a group in a layout. */
    function pillsHtml(conf: LayoutSettings, group: Group): string {
        const current = conf.profiles[conf.layout][group];
        const name = JE.t(GROUP_META[group].nameKey);
        const slots = slotsFor(conf.layout, group);
        // One Tab stop per picker (the chosen position); arrow keys move between positions.
        const stop = current !== undefined && slots.includes(current) ? current : slots[0];
        return slots.map((slot) => {
            const label = slotLabel(conf.layout, slot);
            const content = slot === 'off' && conf.layout === 'corners' ? '<span class="material-icons" aria-hidden="true">visibility_off</span>' : escapeHtml(label);
            return `<button type="button" class="je-tge-pill" data-slot="${slot}" aria-pressed="${slot === current}" tabindex="${slot === stop ? 0 : -1}" aria-label="${escapeHtml(`${name}: ${label}`)}" title="${escapeHtml(label)}">${content}</button>`;
        }).join('');
    }

    /** The "Show up to" stepper value and button states for a group. */
    function stepperState(conf: LayoutSettings, group: Group): { text: string; canDown: boolean; canUp: boolean } {
        const meta = GROUP_META[group];
        const cap = capOf(conf, group);
        if (layout().singleChipGroup(group)) return { text: '1', canDown: false, canUp: false };
        return {
            text: cap === 0 ? JE.t('panel_settings_ui_tag_editor_cap_all') : String(cap),
            canDown: stepCap(cap, -1, meta) !== null,
            canUp: stepCap(cap, 1, meta) !== null,
        };
    }

    /**
     * The quality group's Include pills: the category toggles with their
     * order buttons (the markup ui-panel-settings.ts wires by id/class).
     */
    function qualityIncludeHtml(): string {
        const sorted = sortedQualityCats();
        // Each pair is named by its category ("Move HDR up"), as on the admin page.
        return `<button type="button" class="je-tge-reset je-tge-reorder" data-tge-reorder="cats" aria-pressed="false"><span class="material-icons" aria-hidden="true">swap_vert</span><span>${escapeHtml(JE.t('panel_settings_ui_tag_editor_reorder_categories'))}</span></button>
        <div id="qualityTagsSubToggles" class="je-tge-cats">${sorted.map((c, idx) => `
            <div class="je-quality-cat-row je-tge-cat" data-cat-key="${c.settingKey}" data-order-key="${c.orderKey}" data-default-order="${c.defaultOrder}">
                <label class="je-tge-toggle-pill">
                    <input type="checkbox" id="${c.id}" ${effectiveBool(c.settingKey, c.pluginKey, c.fallback ?? true) ? 'checked' : ''}>
                    <span>${escapeHtml(JE.t(c.labelKey))}</span>
                </label>
                <button type="button" class="je-cat-btn je-cat-up" ${idx === 0 ? 'disabled' : ''} aria-label="${escapeHtml(JE.t('panel_settings_ui_quality_tags_move_up_named', { name: JE.t(c.labelKey) }))}"><span class="material-icons" aria-hidden="true">arrow_upward</span></button>
                <button type="button" class="je-cat-btn je-cat-down" ${idx === sorted.length - 1 ? 'disabled' : ''} aria-label="${escapeHtml(JE.t('panel_settings_ui_quality_tags_move_down_named', { name: JE.t(c.labelKey) }))}"><span class="material-icons" aria-hidden="true">arrow_downward</span></button>
            </div>`).join('')}
        </div>`;
    }

    /** The rating sources module (legacy dereferenced it unconditionally). */
    const ratingSources = () => {
        const sources = JE.ratingSources;
        if (!sources) throw new TypeError('Rating sources are unavailable');
        return sources;
    };

    /** Ordered source checkboxes and accessible move controls, plus score preferences. */
    function ratingIncludeHtml(): string {
        const R = ratingSources();
        const conf = R.settings();
        const order = [...conf.sources, ...R.IDS.filter(id => !conf.sources.includes(id))];
        return `<div class="je-tge-rating-includes">${order.map((id, index) => {
            const source = R.name(id);
            return `<div class="je-rating-source-row" data-source="${id}">
                <label><input type="checkbox" data-rating-source="${id}" ${conf.sources.some(s => s === id) ? 'checked' : ''}>${escapeHtml(source)}</label>
                <button type="button" data-rating-move="-1" ${index === 0 ? 'disabled' : ''} aria-label="${escapeHtml(JE.t('rating_sources_up', { source }))}">↑</button>
                <button type="button" data-rating-move="1" ${index === order.length - 1 ? 'disabled' : ''} aria-label="${escapeHtml(JE.t('rating_sources_down', { source }))}">↓</button>
            </div>`;
        }).join('')}
        <label>${escapeHtml(JE.t('rating_sources_minimum'))} <select data-rating-minimum>${[0,5,6,7,8].map(n => `<option value="${n}" ${conf.minimum === n ? 'selected' : ''}>${n || escapeHtml(JE.t('track_off'))}</option>`).join('')}</select></label>
        <label><input type="checkbox" data-rating-color ${conf.color ? 'checked' : ''}>${escapeHtml(JE.t('rating_sources_color'))}</label>
        <div class="je-tge-hint">${escapeHtml(JE.t('rating_sources_help'))}</div></div>`;
    }

    /** The language group's track includes and presentation controls. */
    function languageIncludeHtml(): string {
        const conf = JE.core.languageTags?.readSettings() || {
            audio: effectiveBool('languageTagsShowAudio', 'LanguageTagsShowAudio'),
            subtitles: effectiveBool('languageTagsShowSubtitles', 'LanguageTagsShowSubtitles', false),
            style: 'flags', badge: 'off',
        };
        const select = (key: string, label: string, current: string, values: ReadonlyArray<readonly [string, string]>) => `<label class="je-tge-extra"><span class="je-tge-label">${escapeHtml(JE.t(label))}</span>
            <select data-language-key="${key}" style="background:#222;color:#fff;padding:6px;border-radius:6px;">${values.map(([value, text]) => `<option value="${value}" ${value === current ? 'selected' : ''}>${escapeHtml(JE.t(text))}</option>`).join('')}</select></label>`;
        const kinds: ReadonlyArray<readonly ['Audio' | 'Subtitles', boolean]> = [['Audio', conf.audio], ['Subtitles', conf.subtitles]];
        return `<div class="je-tge-includes">${kinds.map(([kind, on]) => `<label class="je-tge-toggle-pill"><input type="checkbox" data-language-key="languageTagsShow${kind}" ${on ? 'checked' : ''}><span>${escapeHtml(t(layout().VOCABULARY_KEYS.language[kind.toLowerCase()]))}</span></label>`).join('')}</div>
            ${select('languageTagsStyle', 'panel_settings_subtitles_style', conf.style, [['flags', 'language_tags_flags'], ['codes', 'language_tags_codes']])}
            ${select('languageTagsCountBadge', 'language_tags_count_badge', conf.badge, [['off', 'track_off'], ['only', 'language_tags_badge_only'], ['both', 'language_tags_badge_both']])}
            ${languagePriorityHtml()}`;
    }

    /** The media-language module (legacy dereferenced it unconditionally). */
    const mediaLanguage = () => {
        const M = JE.core.mediaLanguage;
        if (!M) throw new TypeError('Media language support is unavailable');
        return M;
    };

    /** The personal language priority editor; null choices continue to follow server changes. */
    function languagePriorityHtml(): string {
        const M = mediaLanguage();
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
     * "Where to show": the same six switches for every group (item types and home rows), each showing
     * the effective value; a group whose switches all follow the server says so. Rating's switches keep
     * their ids (ratingTagsOn…Toggle).
     */
    function scopeBlockHtml(group: Group, ctx: Pick<PanelContext, 'toggleAccentColor'>): string {
        const S = JE.core.tagScopes;
        if (!S) return '';
        const offered = JE.core.tagSettingsMatrix?.offers('hub', group, 'scopes') ?? true;
        if (offered !== true) return `<div class="je-tge-extra je-tge-hint" data-je-scope-na="${group}">${escapeHtml(JE.t(offered))}</div>`;
        const rows = S.SCOPE_IDS.map((scope) => {
            const id = group === 'rating' ? `ratingTagsOn${scope.charAt(0).toUpperCase()}${scope.slice(1)}Toggle` : `${group}Scope-${scope}`;
            return `<div class="je-quality-cat-row"><label class="je-quality-cat-label-wrap">
                    <input type="checkbox" id="${id}" data-je-scope-group="${group}" data-je-scope="${scope}" ${S.allows(group, scope) ? 'checked' : ''} style="accent-color:${ctx.toggleAccentColor};">
                    <span class="je-quality-cat-label">${escapeHtml(t(SCOPE_LABELS[scope]))}</span>
                </label></div>`;
        }).join('');
        const following = S.SCOPE_IDS.every((scope) => S.scopeOwn(group, scope) === null);
        return `
                <div class="je-tge-extra je-tge-scopes" data-je-scope-block="${group}">
                    <div class="je-tge-label je-tge-section" id="${group}ScopeLabel">${escapeHtml(JE.t('tag_scope_label'))}</div>
                    <div class="je-quality-cat-list je-tge-list-box" role="group" aria-labelledby="${group}ScopeLabel"${group === 'rating' ? ' id="ratingTagsSubToggles"' : ''}>${rows}</div>
                    <button type="button" class="je-tge-reset" data-je-scope-follow="${group}" ${following ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">dns</span><span>${escapeHtml(JE.t(following ? 'tag_scope_following' : 'tag_scope_follow_server'))}</span></button>
                    <div class="je-tge-hint">${escapeHtml(JE.t('tag_scope_hint'))}</div>
                </div>`;
    }

    /**
     * Group-specific settings that existed before the editor (the quality
     * display policies and sound language), kept with their ids.
     */
    function extrasHtml(group: Group, ctx: Pick<PanelContext, 'detailsBackground' | 'toggleAccentColor'>): string {
        const { detailsBackground, toggleAccentColor } = ctx;
        const scopeRow = (id: string, key: string, pluginKey: string, labelKey: string, fallback = true) => `
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
            const serverPolicy = String(JE.inheritedSettingDefault?.(JE.currentSettings, 'seriesQualityAggregation') || 'representative');
            // The display policies are details most people never change: one disclosure, closed.
            return `
                <details class="je-tge-more">
                <summary class="je-tge-more-toggle"><span class="material-icons" aria-hidden="true">expand_more</span>${escapeHtml(JE.t('panel_settings_ui_quality_more'))}</summary>
                <div class="je-tge-more-body">
                <div class="je-tge-extra" data-quality-display>
                    <p class="je-tge-hint">${escapeHtml(JE.t('quality_display_help'))}</p>
                    ${QUALITY_DISPLAY_KEYS.map((key, index) => {
                        const options: ReadonlyArray<readonly [string, string]> = key === 'qualityMinimumResolution' ? [['off', 'track_off'], ['720p', '=720p'], ['1080p', '=1080p'], ['4k', '=4K']]
                            : key === 'qualityHideSdr' ? [['false', 'quality_sdr_show'], ['true', 'quality_hide_sdr']]
                            : [['highest', 'quality_display_highest'], ['all', 'quality_display_all']];
                        const stored = JE.currentSettings[key];
                        const value = JE.isSettingInherited?.(JE.currentSettings, key) || stored == null ? '' : String(stored);
                        return `<label for="${key}Select" class="je-tge-label">${escapeHtml(t(QUALITY_DISPLAY_LABELS[index]))}</label>
                            <select id="${key}Select" data-quality-display-key="${key}" style="width:100%;background:${detailsBackground};color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:6px;padding:6px;">
                                <option value="" ${value === '' ? 'selected' : ''}>${escapeHtml(JE.t('panel_settings_ui_quality_tags_audio_language_default'))}</option>
                                ${options.map(([v, label]) => `<option value="${v}" ${value === v ? 'selected' : ''}>${escapeHtml(label.startsWith('=') ? label.slice(1) : JE.t(label))}</option>`).join('')}
                            </select>`;
                    }).join('')}
                </div>
                ${scopeRow('showLowQualitySourceTagToggle', 'showLowQualitySourceTag', 'ShowLowQualitySourceTag', 'panel_settings_ui_quality_tags_low_source', false)}
                <div class="je-tge-extra">
                    <label for="seriesQualityAggregationSelect" class="je-tge-label">${escapeHtml(JE.t('series_quality_aggregation_label'))}</label>
                    <select id="seriesQualityAggregationSelect" style="width:100%; background:${detailsBackground}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:6px; padding:6px;">
                        <option value="" ${following ? 'selected' : ''}>${escapeHtml(JE.t('language_priority_inherit', { policy: JE.t('series_quality_aggregation_' + serverPolicy) }))}</option>
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
                </div>
                </div>
                </details>`;
        }
        return '';
    }

    /**
     * One group row: header (move buttons, swatch, name + summary that
     * expands the editor, enable toggle) and the collapsed inline editor.
     */
    function rowHtml(conf: LayoutSettings, group: Group, index: number, ctx: EditorContext): string {
        const meta = GROUP_META[group];
        const name = JE.t(meta.nameKey);
        const step = stepperState(conf, group);
        const bodyId = `jeTgeBody-${group}`;
        let include: string;
        if (group === 'quality') include = qualityIncludeHtml();
        else if (group === 'rating') include = ratingIncludeHtml();
        else if (group === 'language') include = languageIncludeHtml();
        else if (group === 'status') include = `<div class="je-tge-hint">${escapeHtml(JE.t('panel_media_tags_badges_include'))}</div>`;
        else if (group === 'logos') include = `<div class="je-tge-hint">${escapeHtml(JE.t('panel_settings_ui_logo_tags_include'))}</div>`;
        else if (group === 'awards') include = `<div class="je-tge-hint">${escapeHtml(JE.t('panel_settings_ui_awards_tags_include'))}</div>`;
        else if (group === 'custom') {
            // The administrator's rules decide the chips (Configuration > Tags > Custom tags).
            const rules = JE.pluginConfig?.CustomTagRules;
            const hasRules = Array.isArray(rules) && rules.length > 0;
            include = `<div class="je-tge-hint">${escapeHtml(JE.t(hasRules ? 'panel_settings_ui_custom_tags_include' : 'panel_settings_ui_custom_tags_none'))}</div>`;
        }
        else include = `<div class="je-tge-hint">${escapeHtml(JE.t('panel_settings_ui_tag_editor_nothing_to_include'))}</div>`;
        // The Status row opens the hub's Status badges tab (its include list).
        const badges = group === 'status'
            ? `<button type="button" class="je-tge-badges" data-je-goto="badges">${escapeHtml(JE.t('panel_media_tags_choose_badges'))}<span class="material-icons" aria-hidden="true">arrow_forward</span></button>`
            : '';
        const single = layout().singleChipGroup(group);
        return `
            <li class="je-tge-row" data-group="${group}" style="--je-tge-swatch:${meta.color};">
                <div class="je-tge-row-head">
                    <div class="je-tge-moves">
                        <button type="button" class="je-tge-move" data-dir="up" ${index === 0 ? 'disabled' : ''} aria-label="${escapeHtml(JE.t('panel_settings_ui_tag_editor_move_up', { group: name }))}"><span class="material-icons" aria-hidden="true">arrow_upward</span></button>
                        <button type="button" class="je-tge-move" data-dir="down" ${index === GROUP_IDS.length - 1 ? 'disabled' : ''} aria-label="${escapeHtml(JE.t('panel_settings_ui_tag_editor_move_down', { group: name }))}"><span class="material-icons" aria-hidden="true">arrow_downward</span></button>
                    </div>
                    <label class="je-tge-enable-hit"><input type="checkbox" class="je-tge-enable" id="${meta.toggleId}" ${JE.currentSettings?.[meta.settingKey] ? 'checked' : ''} aria-label="${escapeHtml(JE.t('panel_settings_ui_tag_editor_enable', { group: name }))}" style="accent-color:${ctx.toggleAccentColor};"></label>
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
                    <div class="je-tge-field" data-je-position role="group" aria-label="${escapeHtml(JE.t('panel_settings_subtitles_position'))}">
                        <div class="je-tge-label je-tge-section" aria-hidden="true">${escapeHtml(JE.t('panel_settings_subtitles_position'))}</div>
                        <div class="je-tge-pills" data-layout="${conf.layout}">${pillsHtml(conf, group)}</div>
                    </div>
                    <div class="je-tge-field" data-je-cap-note ${single ? '' : 'hidden'}>
                        <div class="je-tge-label je-tge-section">${escapeHtml(JE.t('panel_settings_ui_tag_editor_show_up_to'))}</div>
                        <div class="je-tge-hint" data-je-limit-na="${group}">${escapeHtml(JE.t('tag_limit_single'))}</div>
                    </div>
                    <div class="je-tge-field" data-je-cap-control ${single ? 'hidden' : ''}>
                        <div class="je-tge-label je-tge-section" id="jeTgeCapLabel-${group}">${escapeHtml(JE.t('panel_settings_ui_tag_editor_show_up_to'))}</div>
                        <div class="je-tge-stepper" role="group" aria-labelledby="jeTgeCapLabel-${group}">
                            <button type="button" class="je-tge-step" data-step="-1" ${step.canDown ? '' : 'disabled'} aria-label="${escapeHtml(JE.t('panel_settings_ui_tag_editor_cap_decrease', { group: name }))}"><span class="material-icons" aria-hidden="true">remove</span></button>
                            <output class="je-tge-cap" aria-live="polite">${escapeHtml(step.text)}</output>
                            <button type="button" class="je-tge-step" data-step="1" ${step.canUp ? '' : 'disabled'} aria-label="${escapeHtml(JE.t('panel_settings_ui_tag_editor_cap_increase', { group: name }))}"><span class="material-icons" aria-hidden="true">add</span></button>
                        </div>
                    </div>
                    <div class="je-tge-field">
                        <div class="je-tge-label je-tge-section">${escapeHtml(JE.t('panel_settings_ui_tag_editor_include'))}</div>
                        ${include}
                    </div>
                    ${scopeBlockHtml(group, ctx)}
                    ${extrasHtml(group, ctx)}
                </div>
            </li>`;
    }

    /**
     * The group editor: its title, the group rows in priority order and the
     * reset button.
     */
    internal.buildTagGroupEditorHtml = function(ctx: EditorContext) {
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
                    <button type="button" class="je-tge-reset je-tge-reorder" data-tge-reorder="groups" aria-pressed="false"><span class="material-icons" aria-hidden="true">swap_vert</span><span>${escapeHtml(JE.t('panel_settings_ui_tag_editor_reorder_groups'))}</span></button>
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
        layout().promoteLegacySettings(JE.currentSettings);
    }

    /** Save the (already promoted) layout document and re-present every card. */
    function saveLayout() {
        layout().invalidateSettings();
        JE.saveUserSettings('settings.json', JE.currentSettings);
        if (typeof JE.reinitializeTagLayout === 'function') JE.reinitializeTagLayout();
    }

    /** A stored JSON object, or undefined. */
    const own = (value: JsonValue | undefined): { [key: string]: JsonValue } | undefined =>
        value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;

    /**
     * Set a group's slot in one layout profile. For corners, the matching old
     * position setting follows (Native Poster Tags and older clients read it).
     */
    function writeSlot(layoutId: Layout, group: Group, slot: string) {
        const L = layout();
        promote();
        const stored = own(JE.currentSettings.tagLayouts);
        const profiles: { [key: string]: JsonValue } = stored ? { ...stored } : {};
        const pascal = layoutId.charAt(0).toUpperCase() + layoutId.slice(1);
        const profile = own(profiles[layoutId]) || own(profiles[pascal]) || {};
        const listed = Array.isArray(profile.groups) ? profile.groups : Array.isArray(profile.Groups) ? profile.Groups : [];
        const entries: JsonValue[] = listed.filter((entry) => {
            const record = own(entry);
            return L.normalizeGroup(record?.group ?? record?.Group) !== group;
        });
        entries.push({ group, slot });
        delete profiles[pascal];
        profiles[layoutId] = { groups: entries };
        JE.currentSettings.tagLayouts = profiles;
        const position = layoutId === 'corners' ? L.SLOT_TO_POSITION[slot] : undefined;
        if (position) {
            JE.currentSettings[L.POSITION_SETTINGS[group].userKey] = position;
        }
        saveLayout();
    }

    /** Set a group's cap (0 = all), clamped to what the group allows. */
    function writeCap(group: Group, cap: number) {
        promote();
        const caps: { [key: string]: JsonValue } = {};
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

    /** Apply the default group editor's cap policy to a stepper press. */
    function nextCap(group: Group, cap: number, dir: number): number | null {
        return layout().singleChipGroup(group) ? null : stepCap(cap, dir, GROUP_META[group]);
    }

    /** A deep JSON copy of an administrator default (objects only), as "apply defaults" stores it. */
    const copy = (value: JsonValue | undefined): JsonValue => {
        if (value === null || typeof value !== 'object') return null;
        const cloned: unknown = JSON.parse(JSON.stringify(value));
        return isJson(cloned) ? cloned : null;
    };

    /**
     * Restore the administrator's layout defaults (layout, density, slot
     * profiles, the corner positions, order, caps and edge spacing), as "apply defaults to
     * all users" would. Enable toggles, include choices and personal rules
     * are kept; rules are not layout defaults.
     */
    function resetToDefaults() {
        promote();
        const L = layout();
        const p = JE.pluginConfig || {};
        const adminLayout = String(p.TagLayout || '').toLowerCase();
        JE.currentSettings.tagLayout = isLayout(adminLayout) ? adminLayout : 'corners';
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

    /**
     * Wire the editor-owned controls (moves, expand, pills, stepper, rating
     * includes, reset, the Status row's Badges button) and keep the rows in
     * step with the settings after any change, including layout and density
     * changes made on the hub's Layout tab (je:tag-layout-changed). The
     * editor is disposed when the panel closes (ctx.onClose) or is wired again.
     */
    internal.wireTagGroupEditor = function(ctx: WireContext) {
        internal.tagGroupEditor?.dispose();
        const root = document.getElementById('jeTagGroupEditor');
        const L = layoutApi();
        if (!root || !L) return;
        JE.core.ui?.injectCss?.('je-tag-group-editor', EDITOR_CSS);
        const list = queryElement(root, '.je-tge-rows');
        if (!list) return;
        const touch = () => ctx.resetAutoCloseTimer?.();
        let disposed = false;

        // "Where to show": write the personal switch (or follow the server again), save, and redraw that group.
        const redrawScopes = (group: Group) => {
            const block = root.querySelector(`[data-je-scope-block="${group}"]`);
            if (block) block.outerHTML = scopeBlockHtml(group, ctx);
            JE.core.tagRenderer?.reinitialize?.(group === 'ageRating' ? 'agerating' : group);
            // The live preview redraws with the new switches (je:tag-layout-changed).
            document.dispatchEvent(new CustomEvent('je:tag-layout-changed'));
            touch();
        };
        root.addEventListener('change', (e) => {
            const input = e.target;
            if (!(input instanceof HTMLInputElement) || !input.dataset.jeScopeGroup) return;
            const group = input.dataset.jeScopeGroup;
            JE.core.tagScopes?.setOwn(group, input.dataset.jeScope ?? '', input.checked);
            JE.saveUserSettings('settings.json', JE.currentSettings);
            const focusId = input.id;
            if (isGroupId(group)) redrawScopes(group);
            document.getElementById(focusId)?.focus();
        });
        root.addEventListener('click', (e) => {
            const button = closestTarget(e, '[data-je-scope-follow]');
            if (!button || !root.contains(button)) return;
            const group = button.dataset.jeScopeFollow ?? '';
            JE.core.tagScopes?.follow(group);
            JE.saveUserSettings('settings.json', JE.currentSettings);
            if (isGroupId(group)) redrawScopes(group);
            focusElement(root.querySelector(`[data-je-scope-block="${group}"] input`));
        });

        const priorityEditor = root.querySelector('.je-language-priority');
        // Standalone/partial editor mounts may contain only layout rows.
        if (priorityEditor instanceof HTMLFieldSetElement) {
            const M = mediaLanguage();
            // Choices are built once per panel; searching never requests metadata or lays out cards.
            const priorityChoices = M.priorityChoices();
            const priorityNames = new Map(priorityChoices.map(c => [c.code, c.name]));
            let prioritySaving = false;
            const part = <T extends Element>(selector: string, type: new () => T): T => {
                const found = priorityEditor.querySelector(selector);
                if (!(found instanceof type)) throw new TypeError(`Missing language priority control ${selector}`);
                return found;
            };

            /** Filter choices by English name or any equivalent ISO code, excluding selected languages. */
            const filterPriorityChoices = () => {
                const own = M.priorityList(JE.currentSettings.languageTagsPriority) || [];
                const query = part('[data-language-priority-search]', HTMLInputElement).value.trim().toLowerCase();
                /** Exact language names/codes precede family names containing the same word. */
                const exact = (c: { name: string; code: string; aliases: string[] }) => !!query && [c.name, c.code, ...c.aliases.flatMap(a => a.split(';'))]
                    .some(term => term.trim().toLowerCase() === query);
                const choices = priorityChoices.filter(c => !own.includes(c.code) &&
                    `${c.name} ${c.code} ${c.aliases.join(' ')}`.toLowerCase().includes(query))
                    .sort((a, b) => Number(exact(b)) - Number(exact(a))).slice(0, 40);
                const select = part('[data-language-priority-choice]', HTMLSelectElement);
                const previous = select.value;
                select.replaceChildren(...choices.map(c => {
                    const option = document.createElement('option');
                    option.value = c.code;
                    option.textContent = `${c.name} (${c.code.toUpperCase()})`;
                    return option;
                }));
                if (choices.some(c => c.code === previous)) select.value = previous;
                const full = own.length >= M.MAX_PRIORITY_LANGUAGES;
                part('[data-language-priority-action="add"]', HTMLButtonElement).disabled = full || !choices.length;
                select.disabled = full || !choices.length;
            };

            /** Bring the list, inherited choices and count in step with saved or rolled-back settings. */
            const syncPriority = () => {
                const own = M.priorityList(JE.currentSettings.languageTagsPriority);
                part('[data-language-follow]', HTMLInputElement).checked = own === null;
                part('[data-language-personal]', HTMLElement).hidden = own === null;
                part('[data-language-server]', HTMLElement).hidden = own !== null;
                const strict = JE.currentSettings.languageTagsPriorityStrict;
                part('[data-language-priority-strict]', HTMLSelectElement).value = typeof strict === 'boolean' ? String(strict) : 'inherit';
                part('[data-language-priority-count]', HTMLElement).textContent = JE.t('language_priority_count', { count: own?.length || 0 });
                part('[data-language-priority-list]', HTMLElement).innerHTML = (own || []).map((code, i) => {
                    const language = priorityNames.get(code) || code.toUpperCase();
                    return `<li data-language-priority-code="${escapeHtml(code)}"><div><span>${escapeHtml(language)} (${escapeHtml(code.toUpperCase())})</span>
                        <button type="button" data-language-priority-action="up" ${i === 0 ? 'disabled' : ''} aria-label="${escapeHtml(JE.t('language_priority_up', { language }))}">↑</button>
                        <button type="button" data-language-priority-action="down" ${i === (own?.length ?? 0) - 1 ? 'disabled' : ''} aria-label="${escapeHtml(JE.t('language_priority_down', { language }))}">↓</button>
                        <button type="button" data-language-priority-action="remove" aria-label="${escapeHtml(JE.t('language_priority_remove', { language }))}">×</button>
                    </div></li>`;
                }).join('');
                filterPriorityChoices();
            };

            /**
             * Save just the personal language policy through the normal document transport.
             * Pending priority edits are dropped while the fieldset is disabled. A failed
             * write restores the prior policy inside the shared document save queue. A
             * save whose session ended before its queue turn is dropped, never sent to
             * the next account (the same user id on another server included).
             */
            const savePriority = async (changes: { languageTagsPriority?: string[] | null; languageTagsPriorityStrict?: boolean | null }, focus: { code?: string | undefined; action?: string | undefined } = {}) => {
                if (prioritySaving) return;
                const settings = JE.currentSettings;
                const isCurrent = JE.core.tagLook?.captureSession?.();
                let previous: { languageTagsPriority: JsonValue | undefined; languageTagsPriorityStrict: JsonValue | undefined } | undefined;
                prioritySaving = true;
                priorityEditor.disabled = true;
                touch();
                let failed = false;
                try {
                    await JE.saveUserSettings('settings.json', settings, {
                        throwOnError: true,
                        ...(isCurrent ? { isCurrent } : {}),
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
                part('[data-language-priority-status]', HTMLElement).textContent = JE.t(failed ? 'language_priority_save_failed' : 'language_priority_saved');
                const row = queryElements(priorityEditor, '[data-language-priority-code]').find(el => el.dataset.languagePriorityCode === focus.code);
                const target = row?.querySelector(`[data-language-priority-action="${focus.action}"]:not(:disabled)`)
                    || row?.querySelector('button:not(:disabled)')
                    || priorityEditor.querySelector('[data-language-priority-action="add"]:not(:disabled)')
                    || priorityEditor.querySelector('[data-language-follow]');
                if (focus.action) focusElement(target);
            };
            priorityEditor.addEventListener('input', e => {
                if (targetElement(e)?.matches('[data-language-priority-search]')) { filterPriorityChoices(); touch(); }
            });
            priorityEditor.addEventListener('change', e => {
                const target = e.target;
                if (target instanceof HTMLInputElement && target.matches('[data-language-follow]')) savePriority({ languageTagsPriority: target.checked ? null : [] });
                if (target instanceof HTMLSelectElement && target.matches('[data-language-priority-strict]')) savePriority({ languageTagsPriorityStrict: target.value === 'inherit' ? null : target.value === 'true' });
            });
            priorityEditor.addEventListener('click', e => {
                const button = closestTarget(e, '[data-language-priority-action]');
                if (!button || isDisabled(button) || prioritySaving) return;
                const action = button.dataset.languagePriorityAction;
                const own = (M.priorityList(JE.currentSettings.languageTagsPriority) || []).slice();
                const row = button.closest('[data-language-priority-code]');
                const code = (row instanceof HTMLElement ? row.dataset.languagePriorityCode : undefined) || part('[data-language-priority-choice]', HTMLSelectElement).value;
                const i = own.indexOf(code);
                if (action === 'add') {
                    if (!code || i !== -1 || own.length >= M.MAX_PRIORITY_LANGUAGES) return;
                    own.push(code);
                } else if (action === 'remove') {
                    if (i === -1) return;
                    own.splice(i, 1);
                } else {
                    const to = i + (action === 'up' ? -1 : 1);
                    const here = own[i], there = own[to];
                    if (i < 0 || to < 0 || to >= own.length || here === undefined || there === undefined) return;
                    own[i] = there;
                    own[to] = here;
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
            const active = document.activeElement;
            const focusedRow = active?.closest?.('.je-tge-row');
            const focused = focusedRow && list.contains(focusedRow) && active instanceof HTMLElement ? active : null;
            let previous: Element | null = null;
            for (const group of order) {
                const row = list.querySelector(`.je-tge-row[data-group="${group}"]`);
                if (!row) continue;
                const expected: Element | null = previous ? previous.nextElementSibling : list.firstElementChild;
                // Keep an unchanged row connected: moving a focused control's
                // ancestor drops focus and can scroll the entire dialog frame.
                if (row !== expected) list.insertBefore(row, expected);
                previous = row;
            }
            // A real order change can detach the focused row: restore focus without scrolling.
            if (focused && document.activeElement !== focused && focused.isConnected) focused.focus({ preventScroll: true });
            const rows = queryElements(list, '.je-tge-row');
            rows.forEach((row, index) => {
                const group = row.dataset.group;
                if (!isGroupId(group)) return;
                setDisabled(row.querySelector('.je-tge-move[data-dir="up"]'), index === 0);
                setDisabled(row.querySelector('.je-tge-move[data-dir="down"]'), index === rows.length - 1);
                const summary = row.querySelector('.je-tge-summary');
                if (summary) summary.textContent = summaryOf(conf, group);
                const pills = queryElement(row, '.je-tge-pills');
                if (pills) {
                    const focusedPill = document.activeElement;
                    const pillFocus = focusedPill instanceof HTMLElement && pills.contains(focusedPill) ? focusedPill.dataset.slot : null;
                    pills.dataset.layout = conf.layout;
                    pills.innerHTML = pillsHtml(conf, group);
                    if (pillFocus) focusElement(pills.querySelector(`[data-slot="${pillFocus}"]`));
                }
                const capControl = queryElement(row, '[data-je-cap-control]');
                if (capControl) capControl.hidden = layout().singleChipGroup(group);
                const capNote = queryElement(row, '[data-je-cap-note]');
                if (capNote) capNote.hidden = !layout().singleChipGroup(group);
                const step = stepperState(conf, group);
                const cap = row.querySelector('.je-tge-cap');
                if (cap) cap.textContent = step.text;
                setDisabled(row.querySelector('.je-tge-step[data-step="-1"]'), !step.canDown);
                setDisabled(row.querySelector('.je-tge-step[data-step="1"]'), !step.canUp);
            });
        };

        /** Persist ordered enabled sources after a toggle or a move, then redraw the real preview. */
        const saveRatings = () => {
            const box = root.querySelector('.je-tge-rating-includes');
            if (!box) return;
            JE.currentSettings.ratingTagsSources = queryElements(box, '[data-rating-source]:checked').map(el => el.dataset.ratingSource ?? '');
            JE.currentSettings.ratingTagsMinScore = Number(querySelect(box, '[data-rating-minimum]')?.value);
            JE.currentSettings.ratingTagsColorByScore = queryInput(box, '[data-rating-color]')?.checked;
            JE.saveUserSettings('settings.json', JE.currentSettings);
            JE.reinitializeRatingTags?.();
            internal.mediaTagsHub?.refreshPreview?.();
            document.dispatchEvent(new CustomEvent('je:tag-layout-changed'));
            touch();
        };

        // Arrow keys, Home and End move along a group's position picker (Enter or Space picks).
        root.addEventListener('keydown', (e) => {
            const pill = closestTarget(e, '.je-tge-pills .je-tge-pill');
            if (!pill || !pill.parentElement || e.altKey || e.ctrlKey || e.metaKey) return;
            const pills = queryElements(pill.parentElement, '.je-tge-pill');
            const at = pills.indexOf(pill);
            const keySteps: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
            const step = Object.prototype.hasOwnProperty.call(keySteps, e.key) ? keySteps[e.key] : undefined;
            const next = step ? pills[(at + step + pills.length) % pills.length] : e.key === 'Home' ? pills[0] : e.key === 'End' ? pills[pills.length - 1] : null;
            if (!next) return;
            e.preventDefault();
            pills.forEach((p) => { p.tabIndex = p === next ? 0 : -1; });
            next.focus();
        });
        root.addEventListener('click', (e) => {
            const target = targetElement(e);
            if (!target) return;
            const sourceMove = closestTarget(e, '[data-rating-move]');
            if (sourceMove && !isDisabled(sourceMove)) {
                const sourceRow = sourceMove.closest('[data-source]');
                if (!sourceRow) return;
                const before = sourceMove.dataset.ratingMove === '-1' ? sourceRow.previousElementSibling : sourceRow.nextElementSibling;
                if (!before?.matches('[data-source]')) return;
                if (sourceMove.dataset.ratingMove === '-1') before.before(sourceRow); else before.after(sourceRow);
                const rows = sourceRow.parentElement ? Array.from(sourceRow.parentElement.querySelectorAll('[data-source]')) : [];
                rows.forEach((el, i) => { setDisabled(el.querySelector('[data-rating-move="-1"]'), i === 0); setDisabled(el.querySelector('[data-rating-move="1"]'), i === rows.length - 1); });
                saveRatings();
                focusElement(isDisabled(sourceMove) ? sourceRow.querySelector('[data-rating-move]:not(:disabled)') : sourceMove);
                return;
            }
            const row = closestTarget(e, '.je-tge-row');
            const rowGroup = row?.dataset.group;
            const group = isGroupId(rowGroup) ? rowGroup : null;

            const move = closestTarget(e, '.je-tge-move');
            if (move && row && !isDisabled(move)) {
                const order = displayOrder(readConf());
                const from = group ? order.indexOf(group) : -1;
                const to = from + (move.dataset.dir === 'up' ? -1 : 1);
                if (!group || from < 0 || to < 0 || to >= order.length) return;
                order.splice(to, 0, ...order.splice(from, 1));
                promote();
                JE.currentSettings.tagGroupOrder = order;
                saveLayout();
                sync();
                // Keep focus on the group's control; at an end, on its other move button.
                const same = queryButton(row, `.je-tge-move[data-dir="${move.dataset.dir}"]`);
                focusElement(same?.disabled ? row.querySelector('.je-tge-move:not(:disabled)') : same);
                internal.mediaTagsHub?.announce?.(JE.t('panel_media_tags_group_moved', { group: JE.t(GROUP_META[group].nameKey), n: to + 1 }));
                touch();
                return;
            }

            const expand = closestTarget(e, '.je-tge-expand');
            if (expand && row) {
                const open = expand.getAttribute('aria-expanded') !== 'true';
                expand.setAttribute('aria-expanded', String(open));
                const body = queryElement(row, '.je-tge-body');
                if (body) body.hidden = !open;
                touch();
                return;
            }

            if (target.closest('.je-tge-badges')) {
                internal.mediaTagsHub?.openTab?.('badges', { focus: true });
                touch();
                return;
            }

            const pill = closestTarget(e, '.je-tge-pill');
            if (pill && row) {
                if (group) writeSlot(readConf().layout, group, pill.dataset.slot || 'off');
                sync();
                touch();
                return;
            }

            const step = closestTarget(e, '.je-tge-step');
            if (step && row && !isDisabled(step)) {
                const next = group ? nextCap(group, capOf(readConf(), group), Number(step.dataset.step)) : null;
                if (group && next !== null) writeCap(group, next);
                sync();
                // The pressed button may have just been disabled (an end of the range).
                if (isDisabled(step)) focusElement(row.querySelector('.je-tge-step:not(:disabled)'));
                touch();
                return;
            }

            // Phone: the order buttons show only in reorder mode (one switch for groups, one for categories).
            const reorder = closestTarget(e, '[data-tge-reorder]');
            if (reorder) {
                const kind = reorder.dataset.tgeReorder;
                const on = !root.classList.contains(`je-tge--reorder-${kind}`);
                root.classList.toggle(`je-tge--reorder-${kind}`, on);
                root.querySelectorAll(`[data-tge-reorder="${kind}"]`).forEach((b) => {
                    b.setAttribute('aria-pressed', String(on));
                    const label = b.lastElementChild;
                    if (label) label.textContent = JE.t(on ? 'panel_settings_ui_tag_editor_reorder_done' : (kind === 'groups' ? 'panel_settings_ui_tag_editor_reorder_groups' : 'panel_settings_ui_tag_editor_reorder_categories'));
                });
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
            const target = e.target;
            if (!(target instanceof HTMLElement)) return;
            if (target.matches('[data-rating-source], [data-rating-minimum], [data-rating-color]')) { saveRatings(); return; }
            const languageKey = target.dataset?.languageKey;
            if (languageKey) {
                JE.currentSettings[languageKey] = target instanceof HTMLInputElement && target.type === 'checkbox' ? target.checked
                    : target instanceof HTMLInputElement || target instanceof HTMLSelectElement ? target.value : undefined;
                JE.saveUserSettings('settings.json', JE.currentSettings);
                if (JE.currentSettings.languageTagsEnabled) JE.reinitializeLanguageTags?.();
                document.dispatchEvent(new CustomEvent('je:tag-layout-changed'));
                touch();
                return;
            }
            const includeKey = target.dataset?.includeKey;
            if (includeKey) {
                JE.currentSettings[includeKey] = target instanceof HTMLInputElement ? target.checked : undefined;
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
        const api: TagGroupEditorApi = { sync, nextCap, dispose };
        internal.tagGroupEditor = api;
        ctx.onClose?.(dispose);
    };

    // Read by the hub's live preview (ui-panel-tag-preview.ts) at draw time.
    const editorData: TagGroupEditorData = { GROUP_META, QUALITY_CATS, sortedQualityCats, effectiveBool, stepCap };
    internal.tagGroupEditorData = editorData;
}

installUiPanelTagEditor(panelHost());
