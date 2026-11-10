/**
 * @file The Media Tags admin tab's text: English as written (the configuration
 * page is not translated), with {name} filled in from params and
 * {n|one|many} picking a word by a count, and the names the page shows for
 * layouts, groups, positions and presets.
 */

/** Values a text fills in. */
export type FmtParams = Readonly<Record<string, string | number>>;
export type Fmt = (text: unknown, params?: FmtParams) => string;

/**
 * The page's text with its params filled in.
 * @param text - Shown as `String(text)` (an unknown word reads as written).
 * @param params
 * @returns {string}
 */
export const fmt: Fmt = (text, params) => {
    let out = String(text);
    if (params) {
        out = out.replace(/\{(\w+)\|([^|{}]*)\|([^|{}]*)\}/g, (_m, name: string, one: string, many: string) => (Number(params[name]) === 1 ? one : many));
        for (const [name, value] of Object.entries(params)) out = out.split('{' + name + '}').join(String(value));
    }
    return out;
};

/**
 * Markup-safe text: `&`, `<`, `>` and `"` escaped (the editors' own escaper).
 * @param text
 * @returns {string}
 */
export const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A table of words by id. */
export type Words = Readonly<Record<string, string>>;

/** The word tables of the page. */
export interface WordTables {
    reason: Words; type: Words; layout: Words; preset: Words; group: Words; slot: Words; field: Words; density: Words;
    layoutName: Words; shape: Words; shapeRecommended: Words; styleTarget: Words; colourTarget: Words;
}

/** The names the page shows for layouts, groups, positions, presets and the like, in English. */
export const WORDS: WordTables = {
    // Why a group has no control, by the key the shared settings matrix (core/tag-renderer-base.js) names it with.
    reason: {
        tag_scope_people_na: 'People Tags appear on cast cards on detail pages, not on media cards, so they have no position, limit or Where to show.',
        tag_limit_single: 'Always one tag: this group shows a single badge.',
        tag_item_editor_scope_note: 'Where each group shows (movies, series, seasons, episodes and the home rows) is chosen for all titles in Media Tags settings.',
    },
    type: { movie: 'Movie', series: 'Series', season: 'Season', episode: 'Episode', boxset: 'Collection', video: 'Video' },
    layout: { corners: 'Corners', bands: 'Bands', caption: 'Caption', summary: 'Summary', minimal: 'Minimal' },
    preset: { default: 'Default', glass: 'Glass', outline: 'Outline', dark: 'Dark', light: 'Light', mono: 'Mono', poster: 'Poster' },
    group: {
        status: 'Status', quality: 'Quality', rating: 'Rating', age_rating: 'Age Rating', logos: 'Logos',
        language: 'Language', genre: 'Genre', custom: 'Custom', awards: 'Awards',
    },
    slot: {
        off: 'Hidden',
        corners_tl: 'Top left', corners_tc: 'Top centre', corners_bc: 'Bottom centre', corners_ml: 'Left centre',
        corners_mr: 'Right centre', corners_c: 'Centre', corners_tr: 'Top right', corners_bl: 'Bottom left', corners_br: 'Bottom right',
        bands_top: 'Top band', bands_bottom: 'Bottom row',
        caption_poster: 'On poster', caption_caption: 'Caption',
        summary_pill: 'In pill', summary_hover: 'On hover',
        minimal_top: 'Top', minimal_dots: 'Dots', minimal_corner: 'Corner', minimal_hover: 'On hover',
    },
    field: { library: 'Library', type: 'Type', genre: 'Genre', agerating: 'Age rating' },
    density: { full: 'Full', compact: 'Compact' },
    layoutName: {
        corners: 'Corners: place each group anywhere on the poster',
        bands: 'Bands: a strip along the top and bottom, the middle stays clear',
        caption: 'Caption: tags in a line below the poster',
        summary: 'Summary: one short fact pill, every tag on hover',
        minimal: 'Minimal: status, quality dots and score, the rest on hover',
    },
    shape: { landscape: 'Episode thumbnails', list: 'List rows' },
    shapeRecommended: {
        landscape: 'Recommended: bands, compact (status and age on top, quality and rating below)',
        list: 'Recommended: corners, compact (quality, status and rating, up to 2 each)',
    },
    styleTarget: { web: 'Web', native: 'Native posters', both: 'Both' },
    colourTarget: { web: 'Web only', native: 'Native posters only', both: 'Web + native posters' },
};

/**
 * A word of a table, or undefined (the page then shows "undefined", as it always did).
 * @param table
 * @param key
 * @returns {string|undefined}
 */
export function word(table: Words, key: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}
