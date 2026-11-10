/** Pure discovery logic. Nothing here touches the document, the network or a global. */
import type {
    FeedIds, FeedPage, FilterMode, GenreListEntry, GenreSliderEntry, NamedTmdbInfo, SeerrResult
} from './types';

export const FILTER_MODES = { MIXED: 'mixed', MOVIES: 'movies', TV: 'tv' } as const;
export const SORT_OPTIONS = [
    { value: '', label: 'Popular' },
    { value: 'vote_average.desc', label: 'Top Rated' },
    { value: 'release_date.desc', label: 'Newest' },
    { value: 'release_date.asc', label: 'Oldest' }
];
/** TMDB refuses discover pages beyond 500 (Seerr answers HTTP 500) even when it reports thousands. */
export const TMDB_MAX_PAGE = 500;
/** Page size the batch sizing assumes for a Seerr discover feed. */
const FEED_PAGE_SIZE = 20;
const MAX_PAGES_PER_FEED = 4;
const MAX_PAGES_PER_FEED_ESCALATED = 8;
const MEDIA_AVAILABLE = 5;

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isFilterMode(value: unknown): value is FilterMode {
    return value === FILTER_MODES.MIXED || value === FILTER_MODES.MOVIES || value === FILTER_MODES.TV;
}
export function isSeerrResult(value: unknown): value is SeerrResult { return isRecord(value); }
export function isAbortError(error: unknown): boolean { return isRecord(error) && error.name === 'AbortError'; }
export function abortError(message = 'Aborted'): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}
export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortError();
}
function decodeError(what: string): Error {
    const error = new Error(`Unexpected ${what} response`);
    error.name = 'DecodeError';
    return error;
}
const text = (value: unknown): string => typeof value === 'string' ? value : '';

export function interleaveArrays<A, B>(first: readonly A[], second: readonly B[]): Array<A | B> {
    const result: Array<A | B> = [];
    const left = first[Symbol.iterator]();
    const right = second[Symbol.iterator]();
    for (;;) {
        const a = left.next();
        const b = right.next();
        if (a.done && b.done) return result;
        if (!a.done) result.push(a.value);
        if (!b.done) result.push(b.value);
    }
}
export function filterByMediaType(results: SeerrResult[], mode: string): SeerrResult[] {
    if (mode === FILTER_MODES.MOVIES) return results.filter(item => item.mediaType === 'movie');
    if (mode === FILTER_MODES.TV) return results.filter(item => item.mediaType === 'tv');
    return results;
}
export function hasBothTypes(tvResults: readonly unknown[] | null | undefined,
    movieResults: readonly unknown[] | null | undefined): boolean {
    return !!tvResults && tvResults.length > 0 && !!movieResults && movieResults.length > 0;
}
export function resultHasBothTypes(results: readonly SeerrResult[] | null | undefined): boolean {
    if (!results) return false;
    return results.some(item => item.mediaType === 'movie') && results.some(item => item.mediaType === 'tv');
}
/** TMDB sorts series on first_air_date where movies use release_date. */
export function tvSortValue(sort: string): string { return sort.replace('release_date', 'first_air_date'); }

const dateOf = (item: SeerrResult): string => text(item.releaseDate) || text(item.firstAirDate);
// Spoiler Guard keeps a hidden score in jeSortRating, so a protected title doesn't sink.
const ratingOf = (item: SeerrResult): number => Number(item.jeSortRating) || Number(item.voteAverage) || 0;

/** Client-side ordering; the empty sort keeps the API's order and the same array. */
export function sortResults(results: SeerrResult[], sortBy: string): SeerrResult[] {
    if (!sortBy) return results;
    const sorted = [...results];
    if (sortBy === 'vote_average.desc') {
        sorted.sort((a, b) => ratingOf(b) - ratingOf(a));
    } else if (sortBy === 'release_date.desc') {
        sorted.sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
    } else if (sortBy === 'release_date.asc') {
        sorted.sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
    }
    return sorted;
}
export function clampPages(totalPages: unknown): number {
    return Math.min(Number(totalPages) || 1, TMDB_MAX_PAGE);
}
/** Pages `start`..`start+count-1`, clipped to the feed's page count. */
export function pageRange(start: number, count: number, total: number): number[] {
    const pages: number[] = [];
    for (let page = start; page < start + count && page <= total; page++) pages.push(page);
    return pages;
}
export interface YieldStats { fetched: number; rendered: number }
/** Fraction of fetched items that survive filtering, for batch sizing. */
export function estimateYield(stats: YieldStats, cold: number, floor: number): number {
    if (stats.fetched < 20) return cold;
    return Math.min(1, Math.max(floor, stats.rendered / stats.fetched));
}
export interface BatchInput {
    readonly wantCards: number;
    readonly feedCount: number;
    readonly yieldRatio: number;
    readonly lastBatchRendered: number;
    readonly lastBatchPages: number;
    readonly pageBudget: number;
}
/**
 * Pages to fetch per feed: sized from the buffer deficit and observed yield, jumping to
 * a full (then doubled) batch after one that rendered nothing, and never past the scroll
 * engine's empty-page budget.
 */
export function planPagesPerFeed(input: BatchInput): number {
    const { wantCards, feedCount, yieldRatio, lastBatchRendered, lastBatchPages, pageBudget } = input;
    const expectedPerPage = Math.max(1, FEED_PAGE_SIZE * feedCount * yieldRatio);
    let pages = Math.min(MAX_PAGES_PER_FEED, Math.max(1, Math.ceil(wantCards / expectedPerPage)));
    if (lastBatchRendered === 0 && lastBatchPages > 0) {
        pages = Math.min(MAX_PAGES_PER_FEED_ESCALATED, Math.max(pages, MAX_PAGES_PER_FEED, lastBatchPages * 2));
    }
    return Math.max(1, Math.min(pages, Math.floor(pageBudget / feedCount)));
}

export function mediaInfoOf(item: SeerrResult): Record<string, unknown> | null {
    return isRecord(item.mediaInfo) ? item.mediaInfo : null;
}
export interface CardPolicy {
    readonly excludeLibrary: boolean;
    readonly excludeBlocklisted: boolean;
    readonly blockedStatus: number | undefined;
}
export const resultKey = (item: SeerrResult): string => `${String(item.mediaType)}-${String(item.id)}`;
/** The batch without repeats or anything already shown. Marks nothing: a batch can still fail to render. */
export function unseenResults(results: readonly SeerrResult[], shown: ReadonlySet<string>): SeerrResult[] {
    const batch = new Set<string>();
    return results.filter(item => {
        const key = resultKey(item);
        if (shown.has(key) || batch.has(key)) return false;
        batch.add(key);
        return true;
    });
}
/** Drops duplicates, and library and blocklisted items when the admin excludes them. */
export function selectCardResults(results: readonly SeerrResult[], policy: CardPolicy): SeerrResult[] {
    const seen = new Set<string>();
    const items: SeerrResult[] = [];
    for (const item of results) {
        const key = resultKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        const info = mediaInfoOf(item);
        if (policy.excludeLibrary && info?.jellyfinMediaId) continue;
        if (policy.excludeBlocklisted && policy.blockedStatus !== undefined && info?.status === policy.blockedStatus) continue;
        items.push(item);
    }
    return items;
}

// ---- Page URLs ----------------------------------------------------------------
function hashParams(hash: string): URLSearchParams | null {
    try { return new URLSearchParams(hash.split('?')[1]); }
    catch { return null; }
}
export function parseDetailId(hash: string): string | null {
    if (!hash.includes('/details') || !hash.includes('id=')) return null;
    return hashParams(hash)?.get('id') ?? null;
}
export function parseListParam(hash: string, param: string): string | null {
    if (!hash.includes('/list') || !hash.includes(`${param}=`)) return null;
    return hashParams(hash)?.get(param) ?? null;
}
/** URLSearchParams already decoded the value; a literal `%` must not lose the tag page. */
export function parseTagName(hash: string): string | null {
    if (!hash.includes('/list') || !hash.includes('type=tag') || !hash.includes('tag=')) return null;
    const params = hashParams(hash);
    if (params?.get('type') !== 'tag') return null;
    const tag = params.get('tag') || '';
    try { return decodeURIComponent(tag); }
    catch { return tag; }
}

// ---- Network values -----------------------------------------------------------
function rowsOf(value: unknown): unknown[] {
    return isRecord(value) && Array.isArray(value.results) ? value.results : [];
}
/** An absent body is an empty last page; a body of the wrong shape is a failed page. */
export function decodeFeedPage(value: unknown): FeedPage {
    if (value === null || value === undefined) return { results: [] };
    if (!isRecord(value)) throw decodeError('feed page');
    const rows = value.results;
    if (rows !== null && rows !== undefined && !Array.isArray(rows)) throw decodeError('feed page');
    const results = Array.isArray(rows) ? rows.filter(isSeerrResult) : [];
    const total = Number(value.totalPages);
    return total > 0 ? { results, totalPages: total } : { results };
}
export function isGenreEntry(value: unknown): value is GenreListEntry {
    return isRecord(value) && typeof value.id === 'number' && typeof value.name === 'string';
}
export function decodeGenreList(value: unknown): GenreListEntry[] {
    if (!Array.isArray(value)) throw decodeError('genre list');
    return value.filter(isGenreEntry);
}
/** The slider list; an entry's backdrops are optional and only strings are kept. */
export function decodeGenreSlider(value: unknown): GenreSliderEntry[] {
    if (!Array.isArray(value)) return [];
    const entries: GenreSliderEntry[] = [];
    for (const row of value) {
        if (!isRecord(row) || typeof row.id !== 'number' || typeof row.name !== 'string') continue;
        const backdrops = Array.isArray(row.backdrops) ? row.backdrops.filter(b => typeof b === 'string') : [];
        entries.push({ id: row.id, name: row.name, backdrops });
    }
    return entries;
}
export function isNamedTmdbInfo(value: unknown): value is NamedTmdbInfo {
    return isRecord(value) && typeof value.name === 'string' &&
        (value.tmdbId === null || value.tmdbId === undefined || typeof value.tmdbId === 'string');
}
/** Keeps only the fields discovery reads; anything else about the item stays out of the cache. */
export function decodeNamedInfo(value: unknown): NamedTmdbInfo | null {
    if (!isRecord(value) || typeof value.name !== 'string') return null;
    const id = value.tmdbId;
    return { name: value.name, tmdbId: typeof id === 'string' ? id : typeof id === 'number' ? String(id) : null };
}
export function positiveInt(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? parseInt(value, 10) : NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
export function isPositiveInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
export function isNullablePositiveInt(value: unknown): value is number | null {
    return value === null || isPositiveInt(value);
}
export function isUserActive(status: unknown): boolean { return isRecord(status) && !!status.active; }
export function hasItemType(item: unknown, type: string): boolean { return isRecord(item) && item.Type === type; }

/** Seerr credits, merged and deduplicated by media type and id. */
export function decodeCredits(value: unknown): SeerrResult[] {
    if (value === null || value === undefined) return [];
    if (!isRecord(value)) throw decodeError('credits');
    const rows = [value.cast, value.crew].flatMap(list => Array.isArray(list) ? list : []);
    const seen = new Set<string>();
    const results: SeerrResult[] = [];
    for (const row of rows) {
        if (!isSeerrResult(row) || !row.id || !row.mediaType) continue;
        const key = resultKey(row);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(row);
    }
    return results;
}
export interface CollectionParts { readonly parts: SeerrResult[]; readonly missing: SeerrResult[] }
/** A collection's movies and the ones not fully available, oldest first. */
export function decodeCollection(value: unknown): CollectionParts | null {
    if (!isRecord(value) || !Array.isArray(value.parts)) return null;
    const parts = value.parts.filter(isSeerrResult);
    const missing = parts
        .map(movie => ({ ...movie, mediaType: movie.mediaType || 'movie' }))
        .filter(movie => (mediaInfoOf(movie)?.status || 1) !== MEDIA_AVAILABLE)
        .sort((a, b) => text(a.releaseDate).localeCompare(text(b.releaseDate)));
    return { parts, missing };
}

interface NamedRow extends Record<string, unknown> { readonly id: number; readonly name: string }
function namedRows(value: unknown): NamedRow[] {
    return rowsOf(value).filter((row): row is NamedRow =>
        isRecord(row) && typeof row.id === 'number' && typeof row.name === 'string');
}
/** Highest score wins; equal scores keep the response's order. */
function bestOf(rows: NamedRow[], score: (row: NamedRow) => number): number | undefined {
    return [...rows].sort((a, b) => score(b) - score(a))[0]?.id;
}
const sameName = (row: NamedRow, name: string): boolean => row.name.toLowerCase() === name.toLowerCase();
/**
 * The company a studio name means. `undefined`: nothing to go on (not worth remembering).
 * `null`: a streaming brand with no exact company. TMDB's search drops the `+`, so "Disney+"
 * would otherwise fall back to Disney Junior and "Paramount+" to Paramount Pictures.
 */
export function pickCompany(response: unknown, name: string): number | null | undefined {
    const rows = namedRows(response);
    if (rows.length === 0) return undefined;
    const exact = rows.filter(row => sameName(row, name));
    if (exact.length === 0 && name.includes('+')) return null;
    return bestOf(exact.length > 0 ? exact : rows,
        row => (row.origin_country === 'US' ? 2 : 0) + (row.logo_path ? 1 : 0));
}
/** Prefers exact names, then a profile picture and more known works. */
export function pickPerson(response: unknown, name: string): number | undefined {
    const people = namedRows(response).filter(row => row.mediaType === 'person');
    const exact = people.filter(row => sameName(row, name));
    return bestOf(exact.length > 0 ? exact : people, row => (row.profilePath ? 2 : 0) +
        Math.min(Array.isArray(row.knownFor) ? row.knownFor.length : 0, 3));
}
export function pickKeyword(response: unknown, name: string): number | undefined {
    const rows = namedRows(response);
    return (rows.find(row => sameName(row, name)) ?? rows[0])?.id;
}
/** Genre ids by lowercase name; TV and movie lists overlap but disagree on ids. */
export function buildGenreMap(tv: readonly GenreListEntry[], movies: readonly GenreListEntry[]): Map<string, FeedIds> {
    const map = new Map<string, FeedIds>();
    const add = (entry: GenreListEntry, kind: keyof FeedIds) => {
        const key = entry.name.toLowerCase();
        const ids = map.get(key) ?? { tv: null, movie: null };
        ids[kind] = entry.id;
        map.set(key, ids);
    };
    tv.forEach(entry => add(entry, 'tv'));
    movies.forEach(entry => add(entry, 'movie'));
    return map;
}
/** The exact name, with partial names filling gaps ("adventure" also means "action & adventure"). */
export function resolveGenreIds(map: ReadonlyMap<string, FeedIds>, genreName: string): FeedIds | null {
    const name = genreName.toLowerCase().trim();
    const result: FeedIds = { ...(map.get(name) ?? { tv: null, movie: null }) };
    for (const [key, ids] of map) {
        if (key === name || !(name.includes(key) || key.includes(name))) continue;
        result.tv ||= ids.tv;
        result.movie ||= ids.movie;
    }
    return result.tv || result.movie ? result : null;
}

/** TMDB TV network ids, which differ from company ids. Matched first to last. */
const TV_NETWORKS: ReadonlyMap<string, number> = new Map([
    ['netflix', 213], ['hbo', 49], ['hbo max', 3186], ['max', 3186], ['amazon', 1024], ['amazon prime video', 1024],
    ['prime video', 1024], ['apple tv+', 2552], ['apple tv', 2552], ['disney+', 2739], ['disney plus', 2739],
    ['hulu', 453], ['paramount+', 4330], ['paramount plus', 4330], ['peacock', 3353], ['fx', 88], ['fx networks', 88],
    ['amc', 174], ['showtime', 67], ['starz', 318], ['abc', 2], ['nbc', 6], ['cbs', 16], ['fox', 19], ['the cw', 71],
    ['cw', 71], ['bbc', 4], ['bbc one', 4], ['bbc two', 332], ['itv', 9], ['channel 4', 26], ['sky', 1063],
    ['syfy', 77], ['usa network', 30], ['tnt', 41], ['tbs', 68], ['a&e', 129], ['history', 65], ['discovery', 64],
    ['national geographic', 43], ['nat geo', 43], ['adult swim', 80], ['cartoon network', 56], ['nickelodeon', 13],
    ['comedy central', 47], ['mtv', 33], ['bet', 24], ['espn', 29], ['crunchyroll', 1112], ['anime network', 171],
    ['funimation', 102], ['youtube', 247], ['youtube premium', 1436]
]);
const isWordCharacter = (character: string | undefined): boolean =>
    character !== undefined && /[\p{L}\p{N}]/u.test(character);
/** A whole-word match: "Skydance" is not Sky, and "Alphabet" is not BET. */
function containsWords(haystack: string, needle: string): boolean {
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
        if (!isWordCharacter(haystack[at - 1]) && !isWordCharacter(haystack[at + needle.length])) return true;
    }
    return false;
}
export function getKnownNetworkId(networkName: string): number | null {
    const key = networkName.toLowerCase().trim();
    if (!key) return null;
    const exact = TV_NETWORKS.get(key);
    if (exact) return exact;
    for (const [name, id] of TV_NETWORKS) {
        if (containsWords(key, name) || containsWords(name, key)) return id;
    }
    return null;
}
