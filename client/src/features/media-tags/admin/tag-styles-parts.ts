/**
 * @file The Tag Styles editor's fixed tables (groups, presets, notes and sample chips) and its element helper,
 * shared by the editor (tag-styles-editor.ts) and its Hidden tags controls (tag-hidden-editor.ts).
 */
import type { RatingSourceId } from '../types/ratings/rating-data';
import { fmt } from './format';

const T = fmt;

export const GROUPS: ReadonlyArray<{ key: string; title: string }> = [
    { key: 'quality', title: T('Quality') }, { key: 'ageRating', title: T('Age Rating') }, { key: 'rating', title: T('Rating') },
    { key: 'genre', title: T('Genre') }, { key: 'status', title: T('Status') }, { key: 'language', title: T('Language') }, { key: 'awards', title: T('Awards') },
    { key: 'logos', title: T('Logos') },
    { key: 'custom', title: T('Custom') },
];
export const PRESET_TITLES: Readonly<Record<string, string>> = {
    default: T('Default'), glass: T('Glass'), outline: T('Outline'), dark: T('Dark'), light: T('Light'), mono: T('Mono'), poster: T('Poster'),
};
export const POSTER_NOTE = T('Poster: each tag takes its background from the artwork it sits on (white or black text, whichever reads better). Colours set here stay on top; Default falls back to the artwork. The preview shows a red poster.');
export const NOTES: Readonly<Record<string, string>> = {
    genre: 'Each genre has its own colours (spellings and translations of a genre share them); Text colours the icon. Genres without an icon of their own use Other.',
    status: 'Status badges use the same colours on web cards and native posters.',
    language: 'Language chips use Background, Border and Text, including per-language colours and Dual/Multi. Flag images keep only their border ring; partial flags keep their dashed outline.',
    logos: 'Colours the pill behind a logo, or the name chip a logo without an image shows (Text colours the name).',
    custom: 'One target per label of the Custom tag rules above (labels shared by several rules share their colours). The icon takes the text colour.',
};
export const LOGO_SAMPLES: Readonly<Record<string, string>> = { provider: T('Stream'), company: T('Studio'), text: 'HBO' };
export const RATING_SAMPLES: Readonly<Record<string, readonly [string | null, string]>> = { community: ['star', '8.1'], critic: [null, '85%'], userReview: ['favorite', '9'], imdb: [null, '8.1'], tmdb: [null, '81%'], rtCritic: [null, '92%'], rtAudience: [null, '88%'], metacritic: [null, '74'], letterboxd: [null, '4.1'], trakt: [null, '85%'], myAnimeList: [null, '8.4'], metacriticUser: [null, '7.9'], rogerEbert: [null, '3.5'], mdblist: [null, '78%'] };
export const STATUS_SAMPLES: Readonly<Record<string, string>> = { added: T('Just Added'), newMovie: T('New Movie'), newSeries: T('New Series'), newEpisode: T('New Episode'), trending: T('#{rank} Today', { rank: 3 }) };
export const RATING_IDS: readonly RatingSourceId[] = ['community', 'critic', 'imdb', 'tmdb', 'rtCritic', 'rtAudience', 'metacritic', 'letterboxd', 'trakt', 'myAnimeList', 'metacriticUser', 'rogerEbert', 'mdblist'];
export const ALL = '*';
// Preview samples: a few genres in their own colours.
export const GENRE_SAMPLES = { movie: ['horror', 'comedy'], episode: ['animation'] };
// The container class each group's chips sit in on a poster.
export const CONTAINERS: Readonly<Record<string, string>> = {
    quality: 'quality-overlay-container', ageRating: 'age-rating-overlay-container', rating: 'rating-overlay-container',
    genre: 'genre-overlay-container', status: 'status-overlay-container', language: 'language-overlay-container', awards: 'awards-overlay-container', logos: 'logo-overlay-container', custom: 'custom-overlay-container',
};

/**
 * Creates an element with an optional class and text.
 * @param tag
 * @param cls
 * @param text
 * @returns {HTMLElement}
 */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
}
