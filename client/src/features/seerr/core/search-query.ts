import type { SeerrMediaItem } from './types';

/** Pure search-row rules of the Seerr search integration. */

/** "Title (YYYY)" → the title to search and the year to filter by; the year applies once ")" is typed. */
export function parseYearedQuery(raw: string): { title: string; year: string | null } {
    const match = raw.match(/^(.*\S)\s*\((\d{4})\)\s*$/);
    return match && match[1] && match[2] ? { title: match[1], year: match[2] } : { title: raw, year: null };
}
/** A result's 4-digit release year, as its card shows it. */
export function resultYear(item: SeerrMediaItem): string | null {
    return item.releaseDate?.substring(0, 4) || item.firstAirDate?.substring(0, 4) || null;
}
export function filterResultsByYear(results: SeerrMediaItem[], year: string | null): SeerrMediaItem[] {
    return year ? results.filter(item => resultYear(item) === year) : results;
}
/** TMDB refuses search pages beyond 500. */
export const TMDB_MAX_PAGE = 500;
export const MAX_SEARCH_PAGES_PER_LOAD = 4;
/**
 * How many pages the next load fetches in parallel: enough to fill the row's
 * deficit at the query's observed post-filter yield, within the page budget.
 */
export function pagesToLoad(wantCards: number, fetched: number, rendered: number, remainingPages: number, pageBudget: number): number {
    const yieldRatio = fetched >= 20 ? Math.min(1, Math.max(0.1, rendered / fetched)) : 0.9;
    return Math.min(MAX_SEARCH_PAGES_PER_LOAD, Math.max(1, remainingPages), pageBudget,
        Math.max(1, Math.ceil(wantCards / (20 * yieldRatio))));
}
/**
 * The results with one synthetic collection card after the first movie of
 * each collection (results keep their identity).
 */
export function withCollectionCards(results: SeerrMediaItem[]): SeerrMediaItem[] {
    const out = results.slice();
    const cards = new Map<string, { card: SeerrMediaItem; position: number }>();
    results.forEach((item, position) => {
        const collection = item.mediaType === 'movie' ? item.collection : null;
        if (!collection || !collection.id) return;
        const key = String(collection.id);
        if (cards.has(key)) return;
        cards.set(key, { position, card: {
            id: collection.id, mediaType: 'collection', title: collection.name ?? null, name: collection.name ?? null,
            posterPath: collection.posterPath || null, backdropPath: collection.backdropPath || null,
            overview: `${collection.name ?? ''} Collection`, voteAverage: null, releaseDate: null
        } });
    });
    // Insert from the end so earlier positions stay valid.
    for (const { card, position } of [...cards.values()].sort((a, b) => b.position - a.position)) out.splice(position + 1, 0, card);
    return out;
}
