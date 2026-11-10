import { createCardContext } from './card-context';
import { createFitApply } from './fit-apply';
import { createFitMeasure } from './fit-measure';
import { createGroups } from './groups';
import { KIND_LOOK_LIMITS, kindLooksCss, kindLooksToWire, readKindLooks, TAG_KINDS } from './kind-looks';
import { chipsThatFit, compactQualityLabel, preserveLegacySizing, rowBudget, rowsHeight } from './layout-fitting';
import { DEFAULT_CAPS, DEFAULT_ORDER, DEFAULT_PROFILES, EDGE_SPACINGS, LAYOUT_SLOTS, MAX_CAP, normalizeGroup, POSITION_SETTINGS, POSITION_TO_SLOT, readEdge, readGap, readScale, readShapeOverrides, RECOMMENDED_SHAPES, SHAPES, shapesToWire, SLOT_TO_POSITION, TAG_GAPS, TAG_SCALES } from './layout-rules';
import type { LayoutHost } from './layout-runtime-types';
import { createLooks } from './looks';
import { createPresent } from './present';
import { createLayoutState, type LayoutFns } from './state';

/**
 * The tag layout: places each card's tag groups in the user's layout and fits them to the card.
 *
 * Split by concern (frontend.md §1b): state.ts holds the shared mutable state, types and constants; looks,
 * card-context, present, fit-measure, fit-apply and groups are `create*(s, JE, deps)` factories over that
 * state. A call into another module goes through `deps`, filled here in source order (each factory sees the
 * ones before it), so the modules never import each other. This file builds the published api.
 * @param JE - The layout host (tag-layout-entry.ts).
 */
export function createTagLayout(JE: LayoutHost) {
    const s = createLayoutState();
    const deps = {} as LayoutFns;
    Object.assign(deps, createLooks(s, JE, deps));
    Object.assign(deps, createCardContext(s, JE, deps));
    Object.assign(deps, createPresent(s, JE, deps));
    Object.assign(deps, createFitMeasure(s, JE, deps));
    Object.assign(deps, createFitApply(s, JE, deps));
    Object.assign(deps, createGroups(s, JE, deps));

    // A user switch: forget the outgoing user's settings and every fact their
    // cards hold (they may be spoiler-stripped differently for the incoming
    // user), including the item data kept for hosts without a controller and
    // the waits for it; the pipeline re-renders the cards, and
    // je:user-data-loaded re-applies the incoming user's layout.
    JE.session?.onUserChange?.('tag-layout', () => {
        deps.invalidateSettings();
        // Clear first so every hold's timer is cancelled through clearCard,
        // then forget whatever a host without a controller still kept.
        deps.clearAll();
        s.cardData = new WeakMap();
        s.awaitingData = new WeakMap();
    });

    // Explicit translatable vocabularies keep callers independent of locale key names.
    const VOCABULARY_KEYS: Record<'type' | 'layout' | 'edge' | 'gap' | 'preset' | 'group' | 'slot' | 'language' | 'tab' | 'adminTab' | 'field' | 'builtin', Record<string, string>> = { group: {}, slot: {}, language: {}, tab: {}, adminTab: {}, field: {}, builtin: {},
        "type": {
            "movie": "jellyseerr_card_badge_movie",
            "series": "tag_looks_type_series",
            "season": "jellyseerr_report_issue_season",
            "episode": "jellyseerr_report_issue_episode",
            "boxset": "jellyseerr_card_badge_collection",
            "video": "jellyseerr_report_issue_type_video"
        },
        "layout": {
            "corners": "tag_looks_layout_corners",
            "bands": "tag_looks_layout_bands",
            "caption": "panel_settings_ui_tag_slot_caption_caption",
            "summary": "tag_layout_summary",
            "minimal": "tag_looks_layout_minimal"
        },
        "edge": {
            "default": "common_default",
            "tight": "panel_settings_ui_tag_edge_tight",
            "flush": "panel_settings_ui_tag_edge_flush"
        },
        "gap": {
            "tight": "panel_settings_ui_tag_edge_tight",
            "default": "common_default",
            "roomy": "tag_gap_roomy"
        },
        "preset": {
            "default": "common_default",
            "glass": "panel_settings_ui_tag_style_preset_glass",
            "outline": "panel_settings_ui_tag_style_preset_outline",
            "dark": "panel_settings_ui_tag_style_preset_dark",
            "light": "panel_settings_ui_tag_style_preset_light",
            "mono": "panel_settings_ui_tag_style_preset_mono",
            "poster": "panel_settings_ui_tag_style_preset_poster"
        }
    };

    VOCABULARY_KEYS.group = {
        "status": "panel_settings_ui_tag_group_status",
        "quality": "panel_settings_ui_tag_group_quality",
        "rating": "panel_settings_ui_tag_group_rating",
        "age_rating": "panel_settings_ui_tag_group_age_rating",
        "logos": "common_logos",
        "language": "panel_settings_ui_tag_group_language",
        "genre": "common_genre",
        "custom": "common_custom",
        "awards": "awards_label"
    };

    VOCABULARY_KEYS.slot = {
        "off": "panel_settings_ui_tag_slot_off",
        "corners_tl": "panel_settings_ui_tag_slot_corners_tl",
        "corners_tc": "panel_settings_ui_tag_slot_corners_tc",
        "corners_bc": "panel_settings_ui_tag_slot_corners_bc",
        "corners_ml": "panel_settings_ui_tag_slot_corners_ml",
        "corners_mr": "panel_settings_ui_tag_slot_corners_mr",
        "corners_c": "panel_settings_ui_tag_slot_corners_c",
        "corners_tr": "panel_settings_ui_tag_slot_corners_tr",
        "corners_bl": "panel_settings_ui_tag_slot_corners_bl",
        "corners_br": "panel_settings_ui_tag_slot_corners_br",
        "bands_top": "panel_settings_ui_tag_slot_bands_top",
        "bands_bottom": "panel_settings_ui_tag_slot_bands_bottom",
        "caption_poster": "panel_settings_ui_tag_slot_caption_poster",
        "caption_caption": "panel_settings_ui_tag_slot_caption_caption",
        "summary_pill": "panel_settings_ui_tag_slot_summary_pill",
        "summary_hover": "panel_settings_ui_tag_slot_summary_hover",
        "minimal_top": "panel_settings_ui_tag_slot_minimal_top",
        "minimal_dots": "panel_settings_ui_tag_slot_minimal_dots",
        "minimal_corner": "panel_settings_ui_tag_slot_minimal_corner",
        "minimal_hover": "panel_settings_ui_tag_slot_summary_hover"
    };

    VOCABULARY_KEYS.language = {
        "partial_tooltip": "language_tags_partial_tooltip",
        "audio": "jellyseerr_report_issue_type_audio",
        "subtitles": "jellyseerr_report_issue_type_subtitles",
        "style": "panel_settings_subtitles_style",
        "flags": "language_tags_flags",
        "codes": "language_tags_codes",
        "count_badge": "language_tags_count_badge",
        "badge_off": "track_off",
        "badge_only": "language_tags_badge_only",
        "badge_both": "language_tags_badge_both",
        "dual": "language_tags_dual",
        "multi": "language_tags_multi",
        "count_tooltip": "language_tags_count_tooltip",
        "subtitles_sdh": "language_tags_subtitles_sdh"
    };

    VOCABULARY_KEYS.tab = {
        "layout": "common_layout",
        "groups": "common_groups",
        "badges": "panel_media_tags_tab_badges",
        "badges_short": "common_badges",
        "rules": "panel_media_tags_tab_rules",
        "rules_short": "common_rules",
        "colours": "common_colours",
        "server": "common_server",
        "server_name": "panel_media_tags_tab_server_name"
    };

    VOCABULARY_KEYS.adminTab = {
        "overview": "admin_tags_tab_overview",
        "layout": "admin_tags_tab_layout",
        "groups": "common_groups",
        "rules": "common_rules",
        "colours": "common_colours",
        "badges": "panel_media_tags_tab_badges",
        "server": "common_server",
    };

    VOCABULARY_KEYS.field = {
        "library": "tag_looks_field_library",
        "type": "tag_looks_field_type",
        "genre": "common_genre",
        "agerating": "tag_looks_field_agerating"
    };

    VOCABULARY_KEYS.builtin = {
        "cinephile": "tag_presets_builtin_cinephile",
        "cinephile_desc": "tag_presets_builtin_cinephile_desc",
        "minimal": "tag_looks_layout_minimal",
        "minimal_desc": "tag_presets_builtin_minimal_desc",
        "kids": "tag_presets_builtin_kids",
        "kids_desc": "tag_presets_builtin_kids_desc"
    };

    function sizeLabel(kind: string, value: string) {
        return kind === 'scale' ? `${Math.round((TAG_SCALES[value] ?? 1) * 100)}%` : JE.t(VOCABULARY_KEYS.gap[value] || '');
    }

    const api = {
        sizeLabel,
        VOCABULARY_KEYS,
        isLegacySettings: deps.isLegacySettings,
        GROUPS: DEFAULT_ORDER.slice(),
        LAYOUT_SLOTS,
        DEFAULT_ORDER: DEFAULT_ORDER.slice(),
        DEFAULT_CAPS: { ...DEFAULT_CAPS },
        MAX_CAP,
        preserveLegacySizing,
        TAG_SCALES,
        TAG_GAPS,
        TAG_KINDS,
        KIND_LOOK_LIMITS,
        readKindLooks,
        kindLooksToWire,
        kindLooksCss,
        readScale,
        readGap,
        EDGE_SPACINGS: { ...EDGE_SPACINGS },
        DEFAULT_PROFILES,
        SHAPES: SHAPES.slice(),
        RECOMMENDED_SHAPES,
        CONTAINER_CLASS: s.CONTAINER_CLASS,
        SLOT_TO_POSITION,
        POSITION_TO_SLOT,
        POSITION_SETTINGS,
        buildStyles: null as (() => string) | null,
        normalizeGroup,
        readEdge,
        normalizeSettings: deps.normalizeSettings,
        promoteLegacySettings: deps.promoteLegacySettings,
        invalidateSettings: deps.invalidateSettings,
        resolveLayout: deps.resolveLayout,
        lookSource: deps.lookSource,
        setPreviewLook: deps.setPreviewLook,
        shapeOf: deps.shapeOf,
        shapeOfCard: deps.shapeOfCard,
        readShapeOverrides,
        shapesToWire,
        setCardContext: deps.setCardContext,
        cardIdentity: deps.cardIdentity,
        awaitCardContext: deps.awaitCardContext,
        releaseCardContext: deps.releaseCardContext,
        resumePresentation: deps.resumePresentation,
        ensureHost: deps.ensureHost,
        commitGroup: deps.commitGroup,
        removeGroup: deps.removeGroup,
        hasGroup: deps.hasGroup,
        getGroup: deps.getGroup,
        refreshPresentation: deps.refreshPresentation,
        describe: deps.describe,
        clearCard: deps.clearCard,
        clearAll: deps.clearAll,
        removeGroupEverywhere: deps.removeGroupEverywhere,
        prepareCard: deps.prepareCard,
        compactQualityLabel,
        singleChipGroup: deps.singleChipGroup,
        reinitialize: deps.reinitialize,
        flushFit: deps.flushFit,
        fitReveal: deps.fitReveal,
        chipsThatFit,
        rowsHeight,
        rowBudget,
        isGroup: (name: unknown) => normalizeGroup(name) !== null,
    };

    Object.assign(deps, { api });
    return api;
}
export type TagLayout = ReturnType<typeof createTagLayout>;
