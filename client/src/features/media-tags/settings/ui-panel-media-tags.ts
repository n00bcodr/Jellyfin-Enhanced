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
 *   Server         admins only: links to the Media Tags admin tab
 *
 * Every control reads and writes the per-user setting it always did; the
 * ids the settings wiring (ui-panel-settings.js) binds are kept. Admin-only
 * content is never rendered for other users. The preview
 * (ui-panel-tag-preview.js) is a right-hand column on a wide pane and a
 * one-line strip under the tabs on a narrow one; it is built the first time
 * the section shows and disposed with the panel. The panel's settings search
 * finds each control here through the provider this module registers.
 */
import type { Group, Layout, Shape, ShapeLook } from '../layout/layout-rules';
import { apiClient, bindKindLooksHub, currentUserKey, optionalApiClient, panelHost, registry, type PanelBridge, type PanelTagLayout } from './host';
import type { MediaTagsHubApi } from '../public-api';
import type { PanelContext, SearchHit } from '../../settings-panel/public-api';
import { closestTarget, controlValue, focusElement, isDisabled, queryElement, queryElements, targetElement } from '../../shared/dom';
import type { TagPreview } from './ui-panel-tag-preview';
import { isJson } from '../../shared/settings-values';

type Deps = Pick<PanelBridge, 'internals' | 'core' | 'currentSettings' | 'pluginConfig' | 'escapeHtml' | 't' | 'helpers' | 'icon' | 'IconName'
    | 'genreTags' | 'tagPosterColours' | 'saveUserSettings' | 'reinitializeTagLayout'>;
type HubContext = Pick<PanelContext, 'toggleAccentColor' | 'presetBoxBackground'> & Partial<Pick<PanelContext, 'help' | 'resetAutoCloseTimer' | 'onClose' | 'registerSearch' | 'closePanel' | 'openPane'>>;

const LAYOUTS: readonly Layout[] = ['corners', 'bands', 'caption', 'summary', 'minimal'];
const isLayout = (value: string): value is Layout => LAYOUTS.some(id => id === value);
const PRESETS = ['default', 'glass', 'outline', 'dark', 'light', 'mono', 'poster'];
/** The administrator configuration page (Configuration/configPage.html) and its Media Tags tab. */
const ADMIN_PAGE_NAME = 'Jellyfin Enhanced';
const ADMIN_TAB = 'media-tags';
const TAB_STORE_PREFIX = 'JE_mediaTagsTab:';

/** A status badge family switch and the sample chip it shows ([kind, data-je-status, label key, label params]). */
interface BadgeFamily {
    key: string; id: string; fallback: boolean; nameKey: string; descKey: string;
    chip: readonly [string, string, string, Record<string, string | number>?];
    windowKey?: string; windowSetting?: string; windowFallback?: number; requires?: string; requiresKey?: string;
}
/**
 * The status badge families: the setting each switch writes (ids kept from
 * the group editor, so ui-panel-settings.ts saves them), its built-in
 * default, its name and description, the sample chip it shows, and the
 * admin's time window it is limited by.
 */
const BADGE_FAMILIES: readonly BadgeFamily[] = [
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

/** The admin pointers: the Media Tags admin tab's section each one opens. */
const SERVER_LINKS = [
    { nameKey: 'panel_media_tags_server_defaults', descKey: 'panel_media_tags_server_defaults_desc', tab: 'layout' },
    { nameKey: 'panel_media_tags_server_colours', descKey: 'panel_media_tags_server_colours_desc', tab: 'colours' },
    { nameKey: 'panel_media_tags_server_cache', descKey: 'panel_media_tags_server_cache_desc', tab: 'server' },
    { nameKey: 'panel_media_tags_server_native', descKey: 'panel_media_tags_server_native_desc', tab: 'server' },
] as const;

type ChipKind = 'quality' | 'status' | 'rating' | 'genre';
const isChipKind = (value: string): value is ChipKind => value === 'quality' || value === 'status' || value === 'rating' || value === 'genre';
/** Built-in colours of the chips a preset tile shows, for parts a preset leaves alone. */
const CHIP_DEFAULTS: Readonly<Record<ChipKind, { background: string; color: string; border: string }>> = {
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
const POSTER_SAMPLE_ART: Readonly<Record<ChipKind, readonly [number, number, number]>> = { quality: [178, 34, 34], status: [30, 60, 140], rating: [20, 120, 130], genre: [96, 40, 128] };

interface HubTab { id: string; nameKey: string; shortKey?: string; admin?: boolean; icon: string }

/** The user guide section behind each tab (docs/enhanced/tags.md headings). */
const DOCS_URL = 'https://n00bcodr.github.io/Jellyfin-Enhanced/enhanced/tags/';
const DOCS_ANCHORS = { layout: 'layouts', groups: 'tag-groups-order-position-limits', badges: 'badges-and-priority', rules: 'rules-and-locked-items', colours: 'tag-styles-and-css', server: 'server-side-tag-cache' };

/** The guide anchor of a tab, if it has one. */
const docsAnchor = (tab: string): string | undefined => new Map<string, string>(Object.entries(DOCS_ANCHORS)).get(tab);

/** Corners edge spacing choices (core/tag-layout.js EDGE_SPACINGS), in display order. */
const EDGES = ['default', 'tight', 'flush'];
const SHAPE_SELECTS = ['enabled', 'layout', 'density', 'tagScale', 'tagGap'];

/** A field of an untrusted response object. */
const field = (value: unknown, key: string): unknown => value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
/** The colour overrides a tag-styles answer sets for one chip (only non-empty strings). */
const coloursOf = (value: unknown): { background?: string; color?: string; border?: string } => {
    const out: { background?: string; color?: string; border?: string } = {};
    for (const key of ['background', 'color', 'border'] as const) {
        const v = field(value, key);
        if (v) out[key] = String(v);
    }
    return out;
};

/**
 * The visible label of a hub control, for the settings search: its
 * aria-label, the [data-je-label] part of its own label (a tile's or a
 * switch's name, not its description), its aria-labelledby text, or its text.
 */
function controlLabel(el: HTMLElement): string {
    const text = (node: Element | null | undefined) => (node?.textContent || '').replace(/\s+/g, ' ').trim();
    const ownLabel = el.getAttribute('aria-label');
    if (ownLabel) return ownLabel.trim();
    const named = el.querySelector?.('[data-je-label]');
    if (named) return text(named);
    const label = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement || el instanceof HTMLOutputElement || el instanceof HTMLTextAreaElement
        ? el.labels?.[0] : undefined;
    if (label) return text(label.querySelector('[data-je-label]') || label);
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map((id) => text(document.getElementById(id))).join(' ').trim();
    return text(el);
}

export function installUiPanelMediaTags(JE: Deps): void {
    const internal = registry(JE);

    const escapeHtml = (value: unknown) => JE.escapeHtml(String(value));
    /** Translated and escaped. */
    const tx = (key: string | undefined, params?: Record<string, string | number>) => escapeHtml(JE.t(key ?? '', params));
    const t = (key: string | undefined, params?: Record<string, string | number>) => JE.t(key ?? '', params);

    /** Whether the signed-in user is an administrator (server-computed flag). */
    const isAdmin = () => (JE.helpers?.isAdmin ? JE.helpers.isAdmin() : JE.currentSettings?.isAdmin === true);
    /** Whether the admin lets users pick their own colour preset. */
    const presetsAllowed = () => JE.pluginConfig?.TagStylesAllowUserPreset === true;
    /** The layout controller (legacy dereferenced it while the hub renders). */
    const layout = (): PanelTagLayout => {
        const L = JE.core?.tagLayout;
        if (!L) throw new TypeError('The tag layout controller is unavailable');
        return L;
    };
    const vocab = () => layout().VOCABULARY_KEYS;

    /**
     * The tabs this user gets, in order. Colours only while presets are
     * allowed (admins always, for the colour editor); Server for admins only.
     */
    function tabsFor() {
        const tabs: HubTab[] = [
            // The admin page's icons for the same sections.
            { id: 'layout', nameKey: 'common_layout', icon: 'view_quilt' },
            { id: 'groups', nameKey: 'common_groups', icon: 'label' },
            { id: 'badges', nameKey: 'panel_media_tags_tab_badges', shortKey: 'common_badges', icon: 'new_releases' },
            { id: 'rules', nameKey: 'panel_media_tags_tab_rules', shortKey: 'common_rules', icon: 'rule' },
        ];
        if (presetsAllowed() || isAdmin()) tabs.push({ id: 'colours', nameKey: 'common_colours', icon: 'palette' });
        if (isAdmin()) tabs.push({ id: 'server', nameKey: 'common_server', admin: true, icon: 'dns' });
        return tabs;
    }

    /** Resolve a boolean setting: user override, then admin default, then the built-in default. */
    function effectiveBool(userKey: string, fallback: boolean): boolean {
        const u = JE.currentSettings?.[userKey];
        if (typeof u === 'boolean') return u;
        const a = JE.pluginConfig?.[userKey.charAt(0).toUpperCase() + userKey.slice(1)];
        return typeof a === 'boolean' ? a : fallback;
    }

    /**
     * The configuration page's Media Tags tab (`jeSection=media-tags`), optionally
     * opened at one of its own tabs (`&tab=`; see js/enhanced/admintags/admin-tags.js).
     */
    function configUrl(tab?: string): string {
        const base = `${window.location.origin}${window.location.pathname}`;
        return `${base}#/configurationpage?name=${encodeURIComponent(ADMIN_PAGE_NAME)}&jeSection=${ADMIN_TAB}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}`;
    }

    /** The effective layout settings (layout, density, size, gap, edge spacing), read fresh. */
    function layoutConf(): { layout: string; density: string; edge: string; tagScale?: string; tagGap?: string } {
        const L = JE.core?.tagLayout;
        if (!L) return { layout: 'corners', density: 'full', edge: 'default' };
        L.invalidateSettings();
        return L.normalizeSettings();
    }

    // ── Markup ─────────────────────────────────────────────────────────

    /** A checkbox row (quick switch): the input keeps its old id. */
    function switchRow(id: string, checked: boolean, nameKey: string, descKey: string): string {
        return `
            <label class="je-mth-switch">
                <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} aria-describedby="${id}Desc">
                <span class="je-mth-switch-text">
                    <span class="je-mth-switch-name" data-je-label>${tx(nameKey)}</span>
                    <span class="je-mth-switch-desc" id="${id}Desc">${tx(descKey)}</span>
                </span>
            </label>`;
    }

    /** The shape cards opened this session (kept when the cards are drawn again). */
    const openShapes = new Set<string>();
    /** The editor's cap rule (loaded before the hub in manifest order). */
    const stepCap = (cap: number, dir: number) => {
        const data = internal.tagGroupEditorData;
        if (!data) throw new TypeError('The tag group editor is unavailable');
        return data.stepCap(cap, dir, { capAll: true });
    };

    // Per-shape settings live here, apart from the default layout and group editor.
    /**
     * One shape's reduced profile editor: position pills and chip cap steppers.
     * Uses the controller's group/slot vocabulary; the full group row also owns
     * enable switches, category filters and reordering, which remain global.
     */
    function shapeRowHtml(shape: Shape): string {
        const L = layout();
        const own = L.normalizeSettings().shapes[shape];
        const conf = L.resolveLayout({ shape });
        const shapeName = JE.t(`tag_shapes_${shape}`);
        // Collapsed, the card says what the shape's look is; its fields open on request.
        const summary = [t(L.VOCABULARY_KEYS.layout[conf.layout]), JE.t(`panel_settings_ui_tag_density_${conf.density}`),
            own?.tagScale ? L.sizeLabel('scale', own.tagScale) : ''].filter(Boolean).join(' · ');
        const sizeSelect = (look: ShapeLook, kind: 'scale' | 'gap') => {
            const key = kind === 'scale' ? 'tagScale' : 'tagGap';
            const choices = kind === 'scale' ? L.TAG_SCALES : L.TAG_GAPS;
            const chosen = look[key];
            return `<label>${tx(`tag_${kind}_label`)}<select data-shape-action="${key}" aria-label="${escapeHtml(shapeName)}: ${tx(`tag_${kind}_label`)}">
                        <option value="" ${!chosen ? 'selected' : ''}>${tx('tag_size_inherit')}</option>
                        ${Object.keys(choices).map(id => `<option value="${id}" ${chosen === id ? 'selected' : ''}>${escapeHtml(L.sizeLabel(kind, id))}</option>`).join('')}
                    </select></label>`;
        };
        const controls = own ? `
            <details class="je-mth-shape-more" data-shape-more ${openShapes.has(shape) ? 'open' : ''}>
            <summary class="je-mth-shape-summary"><span class="je-mth-shape-summary-text">${escapeHtml(summary)}</span><span class="je-mth-shape-summary-action">${tx('tag_shapes_edit')}<span class="material-icons" aria-hidden="true">expand_more</span></span></summary>
            <div class="je-mth-shape-fields">
                <label>${tx('panel_settings_ui_tag_layout')}<select data-shape-action="layout" aria-label="${tx('tag_shapes_layout_for', { shape: shapeName })}">
                    ${LAYOUTS.map(id => `<option value="${id}" ${conf.layout === id ? 'selected' : ''}>${tx(L.VOCABULARY_KEYS.layout[id])}</option>`).join('')}
                </select></label>
                <label>${tx('panel_settings_ui_tag_density')}<select data-shape-action="density" aria-label="${tx('tag_shapes_density_for', { shape: shapeName })}">
                    ${['full', 'compact'].map(id => `<option value="${id}" ${conf.density === id ? 'selected' : ''}>${tx(`panel_settings_ui_tag_density_${id}`)}</option>`).join('')}
                </select></label>
                ${sizeSelect(own, 'scale')}${sizeSelect(own, 'gap')}
                <button type="button" class="je-mth-button" data-shape-action="recommended">${tx('tag_shapes_recommended')}</button>
            </div>
            <div class="je-mth-shape-groups">${L.DEFAULT_ORDER.map((group: Group) => {
                const groupName = t(L.VOCABULARY_KEYS.group[`${group === 'ageRating' ? 'age_rating' : group}`]);
                const cap = conf.caps[group];
                return `<div class="je-mth-shape-group" data-shape-group="${group}">
                    <span class="je-mth-label">${escapeHtml(groupName)}</span>
                    <div class="je-mth-shape-positions" role="group" aria-label="${tx('tag_shapes_position_for', { group: groupName, shape: shapeName })}">
                        ${L.LAYOUT_SLOTS[conf.layout].filter(slot => slot !== 'dots' || group === 'quality').map(slot => `<button type="button" data-shape-action="slot" data-value="${slot}" aria-pressed="${conf.slots[group] === slot}">${tx(slot === 'off' ? 'panel_settings_ui_tag_slot_off' : L.VOCABULARY_KEYS.slot[`${conf.layout}_${slot}`])}</button>`).join('')}
                    </div>
                    <div class="je-mth-shape-cap" data-je-cap-control ${L.singleChipGroup(group) ? 'hidden' : ''} role="group" aria-label="${tx('tag_shapes_cap_for', { group: groupName, shape: shapeName })}">
                        <button type="button" data-shape-action="cap" data-value="-1" ${stepCap(cap, -1) === null ? 'disabled' : ''} aria-label="${tx('tag_shapes_fewer', { group: groupName })}">−</button>
                        <output aria-live="polite">${cap === 0 ? tx('panel_settings_ui_tag_editor_summary_all') : cap}</output>
                        <button type="button" data-shape-action="cap" data-value="1" ${stepCap(cap, 1) === null ? 'disabled' : ''} aria-label="${tx('tag_shapes_more', { group: groupName })}">+</button>
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

    /** The independently editable looks for landscape cards and list rows. */
    function shapesHtml(): string {
        return JE.core?.tagLayout ? JE.core.tagLayout.SHAPES.map(shapeRowHtml).join('') : '';
    }

    /** Size or gap segmented control, using the layout controller's validated choices. */
    function sizeControlHtml(kind: 'scale' | 'gap', conf: { tagScale?: string; tagGap?: string }): string {
        const name = kind === 'scale' ? 'Scale' : 'Gap';
        const L = layout();
        const choices = kind === 'scale' ? L.TAG_SCALES : L.TAG_GAPS;
        const chosen = kind === 'scale' ? conf.tagScale : conf.tagGap;
        return `<div class="je-mth-density">
            <div class="je-mth-field-text">
                <span class="je-mth-label" id="jeMth${name}Label">${tx(`tag_${kind}_label`)}</span>
                <span class="je-mth-hint" id="jeMth${name}Desc">${tx(`tag_${kind}_desc`)}</span>
            </div>
            <div class="je-mth-pills" id="jeTag${name}Choice" role="radiogroup" aria-labelledby="jeMth${name}Label" aria-describedby="jeMth${name}Desc">
                ${Object.keys(choices).map(value => `<label class="je-mth-pill"><input type="radio" name="jeTag${name}" value="${value}" ${chosen === value ? 'checked' : ''}><span data-je-label>${escapeHtml(L.sizeLabel(kind, value))}</span></label>`).join('')}
            </div>
        </div>`;
    }

    /** The Layout tab: tiles, density, edge spacing and the quick switches. */
    function layoutPanelHtml(): string {
        const conf = layoutConf();
        const tiles = LAYOUTS.map((id) => `
            <label class="je-mth-tile">
                <input type="radio" name="jeTagLayout" value="${id}" ${conf.layout === id ? 'checked' : ''}>
                <span class="je-mth-tile-art" data-layout="${id}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
                <span class="je-mth-tile-name" data-je-label>${tx(vocab().layout[id])}</span>
            </label>`).join('');
        const density = ['full', 'compact'].map((id) => `
            <label class="je-mth-pill">
                <input type="radio" name="jeTagDensity" value="${id}" ${conf.density === id ? 'checked' : ''}>
                <span data-je-label>${tx(`panel_settings_ui_tag_density_${id}`)}</span>
            </label>`).join('');
        const edge = EDGES.map((id) => `
            <label class="je-mth-pill">
                <input type="radio" name="jeTagEdge" value="${id}" ${conf.edge === id ? 'checked' : ''}>
                <span data-je-label>${tx(vocab().edge[id])}</span>
            </label>`).join('');
        const native = JE.pluginConfig?.NativePosterTagsEnabled === true
            ? switchRow('nativePosterTagsToggle', JE.currentSettings.useNativePosterTags !== false, 'panel_settings_ui_native_poster_tags', 'panel_settings_ui_native_poster_tags_desc')
            : '';
        return `
            <section class="je-mth-card" aria-labelledby="jeMthLayoutTitle">
                <div class="je-mth-card-head"><h4 class="je-mth-card-title" id="jeMthLayoutTitle">${tx('common_layout')}</h4>
                    <button type="button" class="je-mth-button je-mth-jump" data-je-jump="jeMthPresetsTitle"><span class="material-icons" aria-hidden="true">auto_awesome</span>${tx('panel_media_tags_browse_presets')}</button></div>
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
            <div data-je-kind-looks-mount></div><div class="je-mth-shapes">${shapesHtml()}</div>
            <p class="je-mth-hint je-mth-shapes-note">${tx('tag_shapes_limitations')}</p>
            <section class="je-mth-card" aria-labelledby="jeMthSwitchesTitle">
                <h4 class="je-mth-card-title" id="jeMthSwitchesTitle">${tx('panel_media_tags_switches_title')}</h4>
                <p class="je-mth-hint">${tx('panel_media_tags_switches_desc')}</p>
                <div class="je-mth-switches">
                    ${switchRow('tagsHideOnHoverToggle', !!JE.currentSettings.tagsHideOnHover, 'panel_settings_ui_hide_tags_on_hover', 'panel_settings_ui_hide_tags_on_hover_desc')}
                    ${native}
                    ${switchRow('peopleTagsToggle', !!JE.currentSettings.peopleTagsEnabled, 'panel_settings_ui_people_tags', 'panel_settings_ui_people_tags_desc')}
                    <p class="je-mth-hint" data-je-scope-na="people">${tx('tag_scope_people_na')}</p>
                </div>
            </section>
            ${internal.buildTagPortableHtml?.() || ''}`;
    }

    /** A status chip as the status module draws it, for a badge card. */
    function statusChipHtml([kind, status, labelKey, params]: BadgeFamily['chip']): string {
        if (kind === 'trending') {
            const [before = '', after = ''] = JE.t(labelKey, { rank: '\u0001' }).split('\u0001');
            const hash = before.endsWith('#') ? '#' : '';
            return `<span class="status-tag status-tag--${kind}" data-je-status="${status}">${escapeHtml(before.slice(0, before.length - hash.length))}<span class="status-tag-rank">${hash}1</span>${escapeHtml(after)}</span>`;
        }
        return `<span class="status-tag status-tag--${kind}" data-je-status="${status}">${tx(labelKey, params)}</span>`;
    }

    /** The Status badges tab. */
    function badgesPanelHtml(): string {
        const admin = isAdmin();
        const rows = BADGE_FAMILIES.map((f) => {
            const days = Number(f.windowSetting ? JE.pluginConfig?.[f.windowSetting] : undefined) || (f.windowFallback ?? NaN);
            const window = f.windowKey ? `<span class="je-mth-badge-window">${tx(f.windowKey, { days })}</span>`
                : f.requires && JE.pluginConfig?.[f.requires] !== true ? `<span class="je-mth-badge-requires">${tx(f.requiresKey)}</span>` : '';
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

    /** The Rules & locks tab: the rules module renders into the mount. */
    function rulesPanelHtml(): string {
        return `
            <section class="je-mth-card" aria-labelledby="jeTagLooksTitle">
                <h4 class="je-mth-card-title" id="jeTagLooksTitle">${tx('panel_media_tags_tab_rules')}</h4>
                <p class="je-mth-hint">${tx('tag_looks_hub_desc')}</p>
                <div id="jeTagLooksMount"></div>
            </section>`;
    }

    /** The Colours tab: preset tiles while allowed, the editor pointer for admins. */
    function coloursPanelHtml(): string {
        const admin = isAdmin();
        let presets: string;
        if (presetsAllowed()) {
            const chosen = JE.currentSettings.tagStylePreset;
            const configured = JE.pluginConfig.TagStylePreset;
            const mine = typeof chosen === 'string' && PRESETS.includes(chosen) ? chosen : '';
            const server = typeof configured === 'string' && PRESETS.includes(configured) ? configured : 'default';
            const tile = (value: string, name: string, sub = '') => `
                <label class="je-mth-preset">
                    <input type="radio" name="jeTagPreset" value="${value}" ${mine === value ? 'checked' : ''}>
                    <span class="je-mth-preset-chips" data-preset="${value || 'server'}" aria-hidden="true">
                        <span class="je-mth-chip" data-chip="quality">4K</span><span class="je-mth-chip" data-chip="status">${tx('status_tag_compact_added')}</span><span class="je-mth-chip" data-chip="rating">★ 8.1</span><span class="je-mth-chip je-mth-chip-genre" data-chip="genre" data-je-genre="${GENRE_SAMPLE}"><i class="je-mth-chip-glyph">${escapeHtml(JE.genreTags?.iconFor?.(GENRE_SAMPLE) || 'theater_comedy')}</i></span>
                    </span>
                    <span class="je-mth-preset-name" data-je-label>${escapeHtml(name)}</span>${sub ? `<span class="je-mth-preset-sub">${escapeHtml(sub)}</span>` : ''}
                </label>`;
            presets = `
                <div class="je-mth-presets" id="jeTagPresetChoice" role="radiogroup" aria-labelledby="jeMthColoursTitle" aria-describedby="jeMthColoursDesc">
                    ${tile('', JE.t('panel_settings_ui_tag_style_preset_follow'), JE.t('panel_settings_ui_tag_style_preset_server', { preset: t(vocab().preset[server]) }))}
                    ${PRESETS.map((id) => tile(id, t(vocab().preset[id]))).join('')}
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

    /** The Server tab (admins only): one row per configuration page section. */
    function serverPanelHtml(): string {
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

    /** The whole Media Tags section for the panel template. */
    internal.buildMediaTagsHubHtml = function(ctx: PanelContext) {
        const tabs = tabsFor();
        const content: Readonly<Record<string, () => string>> = {
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
                + `<span class="material-icons je-mth-tab-icon" aria-hidden="true">${tab.icon}</span><span class="je-mth-tab-long">${escapeHtml(name)}</span><span class="je-mth-tab-short" aria-hidden="true">${escapeHtml(short)}</span>`
                + (tab.admin ? `<span class="je-mth-admin-chip" aria-hidden="true">${tx('common_admin')}</span>` : '')
                + '</button>';
        }).join('');
        const docsLink = (tab: HubTab) => `<p class="je-mth-docs"><a href="${DOCS_URL}#${docsAnchor(tab.id)}" target="_blank" rel="noopener" aria-label="${tx('media_tags_docs_link_label', { name: JE.t(tab.nameKey) })}"><span class="material-icons" aria-hidden="true">menu_book</span>${tx('media_tags_docs_link')}</a></p>`;
        const panels = tabs.map((tab, i) => `
            <div class="je-mth-panel" role="tabpanel" id="jeMthPanel-${tab.id}" data-tab="${tab.id}" aria-labelledby="jeMthTab-${tab.id}" ${i === 0 ? '' : 'hidden'}>${content[tab.id]?.() ?? ''}${docsLink(tab)}</div>`).join('');
        return `
            <section class="je-pane" data-pane="media-tags">
                <div class="je-mth" id="jeMediaTagsHub" data-tab="${tabs[0]?.id}">
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
                        <span class="material-icons je-mth-strip-saved" role="img" aria-label="${tx('panel_media_tags_autosave')}" title="${tx('panel_media_tags_autosave')}">cloud_done</span>
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
        #jellyfin-enhanced-panel .je-mth-docs { margin: 16px 0 0; font-size: 13px; }
        #jellyfin-enhanced-panel .je-mth-docs a { display: inline-flex; align-items: center; gap: 6px; color: rgba(255,255,255,0.72); }
        #jellyfin-enhanced-panel .je-mth-docs .material-icons { font-size: 16px; }
        #jellyfin-enhanced-panel .je-mth-tab { position: relative; display: inline-flex; align-items: center; gap: 6px; padding: 10px 10px 11px; min-height: 40px; background: transparent; border: 0; color: rgba(255,255,255,0.72); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; border-radius: 6px 6px 0 0; }
        #jellyfin-enhanced-panel .je-mth-tab:hover { color: #fff; background: rgba(255,255,255,0.05); }
        #jellyfin-enhanced-panel .je-mth-tab[aria-selected="true"] { color: var(--je-mth-accent); }
        #jellyfin-enhanced-panel .je-mth-tab[aria-selected="true"]::after { content: ''; position: absolute; left: 6px; right: 6px; bottom: -1px; height: 3px; border-radius: 3px; background: var(--je-mth-accent); }
        #jellyfin-enhanced-panel .je-mth-tab:focus-visible { outline: 2px solid #fff; outline-offset: -2px; }
        #jellyfin-enhanced-panel .je-mth-tab-short { display: none; }
        #jellyfin-enhanced-panel .je-mth-tab-icon { font-size: 18px; }
        #jellyfin-enhanced-panel .je-mth-strip-saved { display: none; }
        #jellyfin-enhanced-panel .je-mth-autosave { display: inline-flex; align-items: center; gap: 4px; margin: 0 0 12px auto; font-size: 12px; color: rgba(255,255,255,0.62); white-space: nowrap; }
        #jellyfin-enhanced-panel .je-mth-autosave .material-icons { font-size: 16px; }

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
        #jellyfin-enhanced-panel .je-mth-card-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
        #jellyfin-enhanced-panel .je-mth-jump { min-height: 32px; padding: 0 10px; font-size: 13px; }
        #jellyfin-enhanced-panel #jeMthPresetsTitle { scroll-margin-top: 72px; }
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
        #jellyfin-enhanced-panel .je-mth-tile { position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 4px 8px; min-height: 40px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.46); background: rgba(0,0,0,0.2); cursor: pointer; text-align: center; }
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
        #jellyfin-enhanced-panel .je-mth-pill { position: relative; display: inline-flex; align-items: center; min-height: 36px; padding: 0 16px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.46); font-size: 13px; cursor: pointer; }
        #jellyfin-enhanced-panel .je-mth-pill:hover { background: rgba(255,255,255,0.06); }
        #jellyfin-enhanced-panel .je-mth-pill:has(input:checked) { background: var(--je-mth-sel); border-color: var(--je-mth-sel); color: #fff; font-weight: 600; }
        #jellyfin-enhanced-panel .je-mth-switches { border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; overflow: hidden; }
        #jellyfin-enhanced-panel .je-mth-switch { display: flex; align-items: flex-start; gap: 12px; padding: 8px 12px; min-height: 40px; box-sizing: border-box; cursor: pointer; }
        #jellyfin-enhanced-panel .je-mth-switch + .je-mth-switch { border-top: 1px solid rgba(255,255,255,0.08); }
        #jellyfin-enhanced-panel .je-mth-switch input { width: 18px; height: 18px; margin: 2px 0 0; flex-shrink: 0; accent-color: var(--je-mth-accent); cursor: pointer; }
        #jellyfin-enhanced-panel .je-mth-switch-text, #jellyfin-enhanced-panel .je-mth-badge-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
        #jellyfin-enhanced-panel .je-mth-switch-name, #jellyfin-enhanced-panel .je-mth-badge-name { font-size: 14px; font-weight: 500; }
        #jellyfin-enhanced-panel .je-mth-switch-desc, #jellyfin-enhanced-panel .je-mth-badge-desc { font-size: 13px; color: rgba(255,255,255,0.66); line-height: 1.4; min-width: 0; }
        /* Two lines at rest; the row never changes height under the pointer. */
        #jellyfin-enhanced-panel .je-mth-switch-desc { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        #jellyfin-enhanced-panel .je-mth-badges { display: flex; flex-direction: column; gap: 6px; }
        #jellyfin-enhanced-panel .je-mth-badge { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.18); }
        #jellyfin-enhanced-panel .je-mth-badge-main { display: flex; align-items: flex-start; gap: 12px; min-width: 0; cursor: pointer; flex: 1; }
        #jellyfin-enhanced-panel .je-mth-badge-main input { width: 18px; height: 18px; margin: 2px 0 0; flex-shrink: 0; accent-color: var(--je-mth-accent); cursor: pointer; }
        #jellyfin-enhanced-panel .je-mth-badge-window { white-space: nowrap; }
        /* Not a .status-overlay-container: the status module removes every one of those when it re-initialises. */
        #jellyfin-enhanced-panel .je-mth-badge-sample { display: inline-flex; flex-shrink: 0; max-width: 45%; }
        #jellyfin-enhanced-panel .je-mth-badge:not(:has(input:checked)) .je-mth-badge-sample { opacity: 0.35; filter: grayscale(1); }
        /* The samples keep a chip shape even while the Status module (and its stylesheet) is off; dimmed then. */
        #jellyfin-enhanced-panel .je-mth-panel:has(#jeMthBadgesOff:not([hidden])) .je-mth-badge-sample .status-tag { display: inline-flex; gap: 0.3em; align-items: center; padding: 3px 8px; border-radius: 6px; background: #2b2f38; color: #fff; font-size: 12px; font-weight: 700; line-height: 1.2; white-space: nowrap; }
        #jellyfin-enhanced-panel .je-mth-panel:has(#jeMthBadgesOff:not([hidden])) .je-mth-badge-sample { opacity: 0.35; filter: grayscale(1); }
        #jellyfin-enhanced-panel .je-mth-actions { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin-top: 10px; }
        #jellyfin-enhanced-panel .je-mth-button { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.46); background: rgba(255,255,255,0.06); color: #fff; font: inherit; font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer; white-space: nowrap; }
        #jellyfin-enhanced-panel .je-mth-button:hover { background: rgba(255,255,255,0.12); }
        #jellyfin-enhanced-panel :is(.je-mth-button, .je-mth-link, .je-mth-strip-toggle):focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        #jellyfin-enhanced-panel .je-mth-button .material-icons, #jellyfin-enhanced-panel .je-mth-link .material-icons { font-size: 16px; }
        #jellyfin-enhanced-panel .je-mth-link { display: inline-flex; align-items: center; gap: 4px; min-height: 36px; color: #7fd3ff; font-size: 13px; }
        #jellyfin-enhanced-panel .je-mth-presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; margin-top: 6px; }
        #jellyfin-enhanced-panel .je-mth-preset { position: relative; display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.46); background: rgba(0,0,0,0.25); cursor: pointer; }
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
            #jellyfin-enhanced-panel .je-panel-main:has(.je-pane.active[data-pane="media-tags"], .je-pane[data-pane="media-tags"].active) > .je-pane-back { position: sticky; top: 6px; z-index: 6; float: left; width: 40px; height: 40px; margin: 6px 0 -46px 0; }
            /* The section select above already names Media Tags: the title stays for screen readers; the tabs sit beside Back. */
            #jellyfin-enhanced-panel .je-pane[data-pane="media-tags"] .je-mth-top .je-pane-title { position: absolute; width: 1px; height: 1px; margin: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
            #jellyfin-enhanced-panel .je-pane[data-pane="media-tags"] .je-mth-tabs { margin-left: 50px; min-height: 44px; }
            /* The tab row stays at the top while a long tab scrolls; the preview strip sits under it. */
            #jellyfin-enhanced-panel .je-pane[data-pane="media-tags"] .je-mth-top { position: sticky; top: 0; z-index: 5; background: rgb(24, 24, 24); }
            #jellyfin-enhanced-panel .je-pane[data-pane="media-tags"] .je-mth-strip { top: 58px; }
            #jellyfin-enhanced-panel .je-pane[data-pane="media-tags"] .je-mth-autosave { display: none; }
            #jellyfin-enhanced-panel .je-pane[data-pane="media-tags"] .je-mth-strip-saved { display: inline-block; flex-shrink: 0; margin-left: auto; font-size: 20px; color: rgba(255,255,255,0.6); }
        }
        @container je-mth (max-width: 679px) {
            #jellyfin-enhanced-panel .je-mth-top { gap: 0; }
            #jellyfin-enhanced-panel .je-mth-top .je-pane-title { margin: 2px 0 8px; font-size: 16px; }
            #jellyfin-enhanced-panel .je-mth-tabs { flex: 1 1 100%; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 2px; }
            #jellyfin-enhanced-panel .je-mth-tab { justify-content: center; min-height: 44px; padding: 8px 2px 9px; font-size: 13px; min-width: 0; }
            #jellyfin-enhanced-panel .je-mth-tab-long, #jellyfin-enhanced-panel .je-mth-tab .je-mth-admin-chip { display: none; }
            #jellyfin-enhanced-panel .je-mth-tab-short { display: inline; overflow: hidden; text-overflow: ellipsis; }
            /* Icon over a short label; the admin section's icon is amber (its name says admin to screen readers). */
            #jellyfin-enhanced-panel .je-mth-tab { flex-direction: column; gap: 2px; padding: 6px 1px 8px; font-size: 12px; }
            #jellyfin-enhanced-panel .je-mth-tab-icon { font-size: 20px; }
            #jellyfin-enhanced-panel .je-mth-tab--admin .je-mth-tab-icon { color: #ffb74d; }
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
            #jellyfin-enhanced-panel .je-mth-strip-text { color: #fff; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            #jellyfin-enhanced-panel .je-mth-strip-chips { color: rgba(255,255,255,0.75); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            #jellyfin-enhanced-panel .je-mth-tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
            #jellyfin-enhanced-panel .je-mth-tile { padding: 8px 2px 6px; }
            #jellyfin-enhanced-panel .je-mth-tile-name { font-size: 13px; }
            #jellyfin-enhanced-panel .je-mtp-view button { min-height: 44px; }
            #jellyfin-enhanced-panel .je-mth-switch-desc { -webkit-line-clamp: 3; }
            /* Phone reading size for help and descriptions (preview metadata stays small). */
            #jellyfin-enhanced-panel :is(.je-mth-hint, .je-mth-switch-desc, .je-mth-badge-desc, .je-tge-hint, .je-tge-summary) { font-size: 14px; line-height: 1.45; }
            #jellyfin-enhanced-panel .je-mth-presets { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            #jellyfin-enhanced-panel .je-mth-pill, #jellyfin-enhanced-panel .je-mth-button, #jellyfin-enhanced-panel .je-mth-strip-toggle { min-height: 44px; }
            #jellyfin-enhanced-panel .je-mtp .je-mtp-view button { min-height: 44px; font-size: 13px; }
            #jellyfin-enhanced-panel .je-mth-density > .je-mth-pills { margin-left: 0; }
            #jellyfin-enhanced-panel .je-mth-pointer { flex-wrap: wrap; }
            #jellyfin-enhanced-panel .je-mth-badge { position: relative; display: block; }
            #jellyfin-enhanced-panel .je-mth-badge-sample { position: absolute; top: 10px; right: 12px; max-width: 40%; }
            #jellyfin-enhanced-panel .je-mth-badge-name { display: block; min-height: 22px; padding-right: 40%; }
            #jellyfin-enhanced-panel .je-mth-autosave { order: 1; flex: 0 1 auto; align-self: center; margin: 0 0 4px auto; color: rgba(255,255,255,0.7); }
            #jellyfin-enhanced-panel .je-mth-tabs { order: 2; }
        }
    `;

    // ── Wiring ─────────────────────────────────────────────────────────

    /**
     * Wire the hub: tabs, layout and density tiles, the preview (built the
     * first time the section shows), the phone strip, search and the
     * pointers to the configuration page. Torn down when the panel closes.
     */
    internal.wireMediaTagsHub = function(ctx: HubContext) {
        internal.mediaTagsHub?.dispose?.();
        const hub = document.getElementById('jeMediaTagsHub');
        if (!hub) return;
        JE.core.ui?.injectCss?.('je-media-tags-hub', HUB_CSS);
        hub.style.setProperty('--je-mth-accent', ctx.toggleAccentColor || '#00a4dc');
        hub.style.setProperty('--je-mth-box', ctx.presetBoxBackground || 'rgba(255,255,255,0.04)');
        const touch = () => { try { ctx.resetAutoCloseTimer?.(); } catch { /* panel closing */ } };
        const tablist = queryElement(hub, '[role="tablist"]');
        const tabs = queryElements(hub, '[role="tab"]');
        const live = queryElement(hub, '#jeMthLive');
        if (!tablist || !live) throw new TypeError('The Media Tags hub markup is incomplete');
        const stripToggle = queryElement(hub, '#jeMthStripToggle');
        const storeKey = `${TAB_STORE_PREFIX}${currentUserKey()}`;
        let disposed = false;
        let preview: TagPreview | null = null;
        let io: IntersectionObserver | null = null;
        let presetsLoaded = false;
        const cleanups: Array<() => void> = [bindKindLooksHub(hub, JE)];

        /** Said by screen readers (polite). */
        const announce = (message: string) => {
            live.textContent = '';
            // A fresh node each time, so the same message twice is announced twice.
            setTimeout(() => { if (!disposed) live.textContent = message; }, 30);
        };

        /** The tab shown now. */
        const current = () => hub.dataset.tab || 'layout';

        /** Spotlight and strip sample for what is being edited on the current tab. */
        const syncFocusOfPreview = () => {
            if (!preview) return;
            const tab = current();
            let spot: string | null = null;
            if (tab === 'badges') spot = 'status';
            else if (tab === 'groups') {
                const open = hub.querySelector('.je-tge-row .je-tge-expand[aria-expanded="true"]');
                const row = open?.closest('.je-tge-row');
                spot = row instanceof HTMLElement ? row.dataset.group || null : null;
            }
            preview.setSpotlight(spot);
            preview.follow(tab === 'rules' ? 'episode' : 'movie');
        };

        /**
         * Show a tab: focusTab moves focus to the tab; focus moves it to the
         * panel's heading. False when this user has no such tab.
         */
        const select = (id: string, opts: { focusTab?: boolean; focus?: boolean } = {}) => {
            const tab = tabs.find((candidate) => candidate.dataset.tab === id);
            if (!tab) return false;
            for (const other of tabs) {
                const on = other === tab;
                other.setAttribute('aria-selected', String(on));
                other.tabIndex = on ? 0 : -1;
                const panel = document.getElementById(`jeMthPanel-${other.dataset.tab}`);
                if (panel) panel.hidden = !on;
            }
            hub.dataset.tab = id;
            try { window.localStorage.setItem(storeKey, id); } catch { /* storage unavailable */ }
            if (id === 'rules') internal.tagLooksPanel?.show?.();
            if (id === 'colours') loadPresetChips();
            syncFocusOfPreview();
            if (opts.focusTab) tab.focus();
            if (opts.focus) {
                const panel = document.getElementById(`jeMthPanel-${id}`);
                const heading = panel ? queryElement(panel, '.je-mth-card-title, .je-tge-title') : null;
                if (heading) {
                    heading.tabIndex = -1;
                    heading.focus();
                }
            }
            touch();
            return true;
        };

        tablist.addEventListener('click', (e) => {
            const tab = closestTarget(e, '[role="tab"]');
            if (tab) select(tab.dataset.tab || 'layout');
        });
        // Roving focus with automatic activation (WAI tabs pattern).
        tablist.addEventListener('keydown', (e) => {
            const index = tabs.findIndex((tab) => tab === document.activeElement);
            if (index < 0) return;
            let next = -1;
            // In a right-to-left interface the tabs run from the right: ArrowLeft goes to the next one.
            const step = getComputedStyle(tablist).direction === 'rtl' || tablist.closest('[dir]')?.getAttribute('dir') === 'rtl' ? -1 : 1;
            if (e.key === 'ArrowRight') next = (index + step + tabs.length) % tabs.length;
            else if (e.key === 'ArrowLeft') next = (index - step + tabs.length) % tabs.length;
            else if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = tabs.length - 1;
            const target = tabs[next];
            if (next < 0 || !target) return;
            e.preventDefault();
            select(target.dataset.tab || 'layout', { focusTab: true });
        });

        // ── Layout tiles and density ──
        const layoutDesc = hub.querySelector('#jeMthLayoutDesc');
        /** Check the radio of a group whose value matches. */
        const check = (name: string, value: string | undefined) => {
            hub.querySelectorAll(`input[name="${name}"]`).forEach((r) => { if (r instanceof HTMLInputElement) r.checked = r.value === value; });
        };
        /** Keep the tiles, the description and the density pills on the effective settings. */
        const syncLayoutChoice = () => {
            if (disposed) return;
            const conf = layoutConf();
            check('jeTagLayout', conf.layout);
            check('jeTagDensity', conf.density);
            check('jeTagScale', conf.tagScale);
            check('jeTagGap', conf.tagGap);
            check('jeTagEdge', conf.edge);
            if (layoutDesc) layoutDesc.textContent = JE.t(`panel_settings_ui_tag_layout_${conf.layout}`);
            const off = queryElement(hub, '#jeMthBadgesOff');
            if (off) off.hidden = !!JE.currentSettings?.statusTagsEnabled;
        };
        document.addEventListener('je:tag-layout-changed', syncLayoutChoice);
        cleanups.push(() => document.removeEventListener('je:tag-layout-changed', syncLayoutChoice));

        // Shape controls save only their own block. Keep an explicit all-off
        // object: null would inherit the administrator's overrides again.
        const shapeMount = queryElement(hub, '.je-mth-shapes');
        /** Redraw shape controls after a default layout change or a reset. */
        const syncShapes = () => {
            if (disposed || !shapeMount) return;
            const active = document.activeElement;
            const row = active?.closest('.je-mth-shape');
            const focus = row instanceof HTMLElement && active instanceof HTMLElement ? {
                shape: row.dataset.shape, action: active.dataset.shapeAction,
                group: queryClosestData(active, '[data-shape-group]', 'shapeGroup'), value: active.dataset.value
            } : null;
            shapeMount.innerHTML = shapesHtml();
            if (focus) {
                const selector = `[data-shape="${focus.shape}"] ${focus.group ? `[data-shape-group="${focus.group}"] ` : ''}[data-shape-action="${focus.action}"]${focus.value ? `[data-value="${focus.value}"]` : ''}`;
                focusElement(shapeMount.querySelector(selector), { preventScroll: true });
            }
        };
        /** A data attribute of the nearest ancestor-or-self matching a selector. */
        function queryClosestData(el: Element, selector: string, key: string): string | undefined {
            const found = el.closest(selector);
            return found instanceof HTMLElement ? found.dataset[key] : undefined;
        }
        document.addEventListener('je:tag-layout-changed', syncShapes);
        cleanups.push(() => document.removeEventListener('je:tag-layout-changed', syncShapes));

        /** A shape select, switch, position or cap edit. */
        const editShape = (event: Event) => {
            const control = closestTarget(event, '[data-shape-action]');
            const row = control?.closest('[data-shape]');
            if (!control || isDisabled(control) || !(row instanceof HTMLElement) || !shapeMount?.contains(row)) return;
            const action = control.dataset.shapeAction ?? '';
            if ((event.type === 'change') !== SHAPE_SELECTS.includes(action)) return;
            const L = layout();
            const shape = row.dataset.shape;
            if (shape !== 'landscape' && shape !== 'list') return;
            L.invalidateSettings();
            const shapes = L.readShapeOverrides(L.normalizeSettings().shapes);
            // Preserve the effective looks of both shapes before promotion.
            L.promoteLegacySettings(JE.currentSettings);
            let look = shapes[shape];
            const value = controlValue(control) ?? '';
            if (action === 'enabled') {
                const on = control instanceof HTMLInputElement && control.checked;
                look = on ? L.readShapeOverrides(L.RECOMMENDED_SHAPES)[shape] : null;
                // Just turned on: show its fields.
                if (on) openShapes.add(shape);
            }
            else if (action === 'recommended') look = L.readShapeOverrides(L.RECOMMENDED_SHAPES)[shape];
            else if (look) {
                const groupName = queryClosestData(control, '[data-shape-group]', 'shapeGroup');
                const group = groupName && L.normalizeGroup(groupName);
                if (action === 'layout' && isLayout(value)) { look.layout = value; look.slots = null; }
                if (action === 'density') look.density = value;
                if (action === 'tagScale' || action === 'tagGap') {
                    if (value) look[action] = value;
                    else delete look[action];
                }
                if (action === 'slot' && group) look.slots = { ...(look.slots || {}), [group]: control.dataset.value ?? '' };
                if (action === 'cap' && group) {
                    const cap = L.resolveLayout({ shape }).caps[group];
                    const next = stepCap(cap, Number(control.dataset.value));
                    if (next === null) return;
                    look.caps = { ...(look.caps || {}), [group]: next };
                }
            }
            shapes[shape] = look;
            const wire: unknown = L.shapesToWire(shapes);
            if (wire && !isJson(wire)) throw new TypeError('Shape overrides are not JSON');
            JE.currentSettings.tagShapeOverrides = wire && isJson(wire) ? wire : { landscape: null, list: null };
            L.invalidateSettings();
            JE.saveUserSettings('settings.json', JE.currentSettings);
            JE.reinitializeTagLayout?.();
            preview?.follow(shape === 'landscape' ? 'episode' : 'list');
            preview?.refresh();
            touch();
        };
        shapeMount?.addEventListener('toggle', (e) => {
            const more = e.target;
            if (!(more instanceof HTMLDetailsElement) || !more.matches('[data-shape-more]')) return;
            const shape = queryClosestData(more, '[data-shape]', 'shape');
            if (!shape) return;
            if (more.open) openShapes.add(shape); else openShapes.delete(shape);
        }, true);
        shapeMount?.addEventListener('change', editShape);
        shapeMount?.addEventListener('click', editShape);

        // Any change in the hub may change what the samples show: redraw
        // after the control's own handler (ui-panel-settings.ts and the
        // editor, which listen closer to the control) saved it.
        hub.addEventListener('change', (e) => {
            const target = e.target;
            if (!(target instanceof Element)) return;
            const name = target instanceof HTMLInputElement ? target.name : '';
            if (name === 'jeTagLayout' && layoutDesc) layoutDesc.textContent = JE.t(`panel_settings_ui_tag_layout_${controlValue(target)}`);
            if (target.id === 'statusTagsToggle') syncLayoutChoice();
            preview?.refresh();
            if (BADGE_FAMILIES.some((f) => f.id === target.id)) {
                preview?.follow(['statusTagsScheduleToggle', 'statusTagsSeriesStatusToggle'].includes(target.id) ? 'series'
                    : target.id === 'statusTagsMilestonesToggle' ? 'episode' : 'movie');
            }
        });
        hub.addEventListener('click', (e) => {
            const target = targetElement(e);
            if (!target) return;
            // "Browse presets": straight to the presets card, focus on its heading.
            const jump = closestTarget(e, '[data-je-jump]');
            if (jump) {
                const heading = queryElement(hub, `#${jump.dataset.jeJump}`);
                if (heading) {
                    heading.tabIndex = -1;
                    heading.scrollIntoView?.({ block: 'start' });
                    heading.focus({ preventScroll: true });
                }
                return;
            }
            const goto = closestTarget(e, '[data-je-goto]');
            const gotoGroup = goto?.dataset.jeGoto;
            if (gotoGroup?.startsWith('groups:')) {
                const group = gotoGroup.slice(7);
                select('groups');
                const row = hub.querySelector(`.je-tge-row[data-group="${group}"]`);
                const expand = row ? queryElement(row, '.je-tge-expand') : null;
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

        // ── Presets, import and export (ui-panel-tag-portable.ts) ──
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
            if (presetsLoaded || !hub?.querySelector('#jeTagPresetChoice')) return;
            presetsLoaded = true;
            const client = optionalApiClient();
            if (!client || !client.ajax) return;
            queryElements(hub, '.je-mth-preset-chips').forEach((box) => {
                const preset = box.dataset.preset;
                const styleClient = apiClient();
                styleClient.ajax({ type: 'GET', url: styleClient.getUrl('JellyfinEnhanced/tag-styles', preset && preset !== 'server' ? { preset } : undefined), dataType: 'json' })
                    .then((styles) => {
                        if (disposed || !box.isConnected) return;
                        // Genre: the first genre the administrator coloured, else the sample one.
                        const genreField = field(styles, 'genre');
                        const genres: object = genreField !== null && typeof genreField === 'object' ? genreField : {};
                        const genre = Object.keys(genres).find((key) => key !== '*' && Reflect.get(genres, key)) || GENRE_SAMPLE;
                        const quality = field(styles, 'quality');
                        const pick: Readonly<Record<ChipKind, unknown>> = {
                            quality: field(quality, '4K') || field(quality, '*'),
                            status: field(field(styles, 'status'), 'added'),
                            rating: field(field(styles, 'rating'), 'community'),
                            genre: Reflect.get(genres, genre) || Reflect.get(genres, '*'),
                        };
                        const glyph = box.querySelector('[data-chip="genre"]');
                        if (glyph instanceof HTMLElement && genre !== GENRE_SAMPLE) {
                            glyph.dataset.jeGenre = genre;
                            const icon = glyph.querySelector('.je-mth-chip-glyph');
                            if (icon) icon.textContent = JE.genreTags?.iconFor?.(genre) || 'theaters';
                        }
                        const stylePreset = field(styles, 'preset');
                        const posterGroupsField = field(styles, 'posterGroups');
                        const posterList: unknown[] = Array.isArray(posterGroupsField) ? posterGroupsField : [];
                        const sampled = stylePreset === 'poster' || posterList.length ? JE.tagPosterColours : null;
                        queryElements(box, '[data-chip]').forEach((chip) => {
                            const chipKind = chip.dataset.chip || 'quality';
                            const kind: ChipKind = isChipKind(chipKind) ? chipKind : 'quality';
                            // With a preset per group, only the chips of a group under Poster take the artwork's colours.
                            const posterGroups = stylePreset === 'poster' ? null : posterList;
                            const art = sampled && (!posterGroups || posterGroups.includes(kind)) ? sampled.normalise(POSTER_SAMPLE_ART[kind]) : null;
                            const base = sampled && art ? { background: sampled.css(art.background), color: sampled.css(art.text), border: sampled.css(art.border) } : CHIP_DEFAULTS[kind];
                            // Overrides the admin set stay on top, field by field.
                            const colours = { ...base, ...coloursOf(pick[kind]) };
                            chip.style.setProperty('background', colours.background, 'important');
                            chip.style.setProperty('color', colours.color, 'important');
                            chip.style.setProperty('border-color', colours.border || 'transparent', 'important');
                        });
                    })
                    .catch((err) => console.warn('🪼 Jellyfin Enhanced: could not load a tag colour preset for the panel', err));
            });
        }

        // ── Preview: built the first time the section is on screen ──
        const mount = queryElement(hub, '#jeMthPreview');
        const build = () => {
            if (preview || disposed || !mount) return;
            preview = internal.createTagPreview?.(mount, { strip: queryElement(hub, '#jeMthStrip'), touch }) || null;
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
        /** The hub's search entries: each control in a tab panel with its label and where it sits ("Groups › Language"). */
        const searchIndex = () => {
            const out: Array<{ label: string; path: string; el: HTMLElement }> = [];
            const seen = new Set<string>();
            for (const panel of queryElements(hub, '[role="tabpanel"]')) {
                const tabName = t(vocab().tab[`${panel.dataset.tab}`]);
                const controls = queryElements(panel, 'input:not([type="hidden"]), select, button, a[href], [role="group"][aria-labelledby], [role="radiogroup"][aria-labelledby]');
                for (const el of controls) {
                    if (el.closest('datalist, [data-je-cap-control][hidden]')) continue;
                    const label = controlLabel(el);
                    if (!label) continue;
                    const row = el.closest('.je-tge-row');
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
         */
        const reveal = (el: HTMLElement) => {
            // Read where the control sits before anything redraws it.
            const panelEl = el.closest('[role="tabpanel"]');
            const panel = panelEl instanceof HTMLElement ? panelEl : null;
            const tabId = panel?.dataset.tab || 'layout';
            const focusKey = el.dataset.jeFocusKey || '';
            const elId = el.id;
            const ruleId = queryClosestData(el, '[data-je-rule-id]', 'jeRuleId') || '';
            const inLocks = !!el.closest('.je-tag-looks-locks');
            const bodyEl = el.closest('.je-tge-body');
            const body = bodyEl instanceof HTMLElement ? bodyEl : null;
            if (panel) select(tabId);
            if (body?.hidden) { const expand = body.closest('.je-tge-row')?.querySelector('.je-tge-expand'); if (expand instanceof HTMLElement) expand.click(); }
            const locksToggle = inLocks ? queryElement(hub, '.je-tag-looks-locks-toggle') : null;
            if (locksToggle && locksToggle.getAttribute('aria-expanded') === 'false' && locksToggle.offsetParent !== null) locksToggle.click();
            const byData = (attr: string, value: string) => queryElements(hub, `[${attr}]`).find((node) => node.getAttribute(attr) === value) || null;
            const byId = elId ? document.getElementById(elId) : null;
            const panelNow = document.getElementById(`jeMthPanel-${tabId}`);
            let target: HTMLElement = el.isConnected ? el
                : (focusKey && byData('data-je-focus-key', focusKey))
                || (byId && hub.contains(byId) ? byId : null)
                || (ruleId && byData('data-je-rule-id', ruleId))
                || (panelNow ? queryElement(panelNow, '.je-mth-card-title, .je-tge-title') : null)
                || tabs.find((tab) => tab.dataset.tab === tabId)
                || el;
            // A control inside a closed disclosure (Quality's More options) is shown first.
            const closed = target.closest('details:not([open])');
            if (closed instanceof HTMLDetailsElement) closed.open = true;
            if (target !== el && !target.matches('button, input, select, a[href], [tabindex]')) target.tabIndex = -1;
            if (target.matches('[role="group"], [role="radiogroup"]')) {
                target = queryElement(target, 'input:checked, button:not(:disabled), input:not(:disabled)') || target;
            }
            if (isDisabled(target)) {
                target = (target.parentElement ? queryElement(target.parentElement, 'button:not(:disabled), input:not(:disabled), select:not(:disabled)') : null) || target;
            }
            target.scrollIntoView?.({ block: 'center' });
            target.focus({ preventScroll: true });
        };

        const unregister = ctx.registerSearch?.({
            pane: 'media-tags',
            /** `query` is lower-case and trimmed. */
            search(query: string): SearchHit[] {
                const words = query.split(/\s+/).filter(Boolean);
                if (!words.length) return [];
                const scored: Array<{ score: number; entry: { label: string; path: string; el: HTMLElement } }> = [];
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
            for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) cleanup();
            if (internal.mediaTagsHub === api) internal.mediaTagsHub = null;
        };
        const api: MediaTagsHubApi = {
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
}

installUiPanelMediaTags(panelHost());
