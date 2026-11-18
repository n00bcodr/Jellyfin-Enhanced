// The further filters of a discovery section (beyond All / Movies / Series): what can be set, what
// a selection asks of Seerr's feeds on a list page, and what it keeps of a person's titles (which
// are all loaded already, so they are filtered here). Pure: no document, no network.
//
// Nothing is offered as a short list of presets where the viewer could mean something else: a
// range is typed (a year or a date, a score, a number of votes, minutes), and a list is the whole
// list (every genre, every language, every service of the region, any keyword).
import type {
    FeedKind, FilterId, FilterScope, FilterSelection, ListId, Match, MatchId, Picked, Range, RangeId, RoutedFeed, SeerrResult
} from './types';

const FEED_FILTERS: readonly FilterId[] = ['year', 'score', 'votes', 'runtime', 'genres', 'withoutGenres', 'language', 'withoutLanguage', 'rating', 'services', 'keywords', 'without'];
/** A person's credits carry no runtime, rating, services or keywords: those are not offered there. */
const PERSON_FILTERS: readonly FilterId[] = ['role', 'year', 'score', 'votes', 'genres', 'withoutGenres', 'language', 'withoutLanguage'];
/** What a loaded title says of itself, and so can be checked here (keepByFilters). */
const LOADED_FILTERS: readonly FilterId[] = ['year', 'score', 'votes', 'genres', 'withoutGenres', 'language', 'withoutLanguage'];
/** The admin's switch for each filter (a list and its Without share one). */
export const FILTER_SWITCHES: Readonly<Record<FilterId, string>> = Object.freeze({
    role: 'JellyseerrFilterRole', year: 'JellyseerrFilterYear', score: 'JellyseerrFilterScore', votes: 'JellyseerrFilterVotes',
    runtime: 'JellyseerrFilterRuntime', genres: 'JellyseerrFilterGenres', language: 'JellyseerrFilterLanguage',
    rating: 'JellyseerrFilterContentRating', services: 'JellyseerrFilterStreaming', keywords: 'JellyseerrFilterKeywords',
    without: 'JellyseerrFilterKeywords', withoutGenres: 'JellyseerrFilterGenres', withoutLanguage: 'JellyseerrFilterLanguage'
});
const RANGE_IDS: readonly RangeId[] = ['year', 'score', 'votes', 'runtime'];
/**
 * The lists where a title can have several of what is ticked, so the viewer chooses whether it needs all of them or
 * any, and how each is asked of Seerr when nothing is chosen (as these filters always asked).
 */
export const MATCH_DEFAULTS: Readonly<Record<MatchId, Match>> = Object.freeze({ genres: 'all', keywords: 'all', services: 'any' });
/** A genre's page's own genre, and a tag's page's own keyword, in a feed's route. */
const GENRE_ROUTE = /\/genre\/(\d+)(?:$|[/?])/;
const KEYWORD_ROUTE = /\/keyword\/\d+(?:$|[/?])/;
const LIST_IDS: readonly ListId[] = ['role', 'genres', 'withoutGenres', 'language', 'withoutLanguage', 'rating', 'services', 'keywords', 'without'];
const RANGE_PARAMS = Object.freeze({ score: 'voteAverage', votes: 'voteCount', runtime: 'withRuntime' });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Whether a filter is a typed range (else a list). */
export const isRangeId = (id: FilterId): id is RangeId => id === 'year' || id === 'score' || id === 'votes' || id === 'runtime';

/**
 * The filters a section of this scope offers (a list page's section, a person's titles, or titles already loaded), in
 * the order they are shown, less the ones the admin turned off (a missing switch means on).
 */
export function offeredFilters(scope: FilterScope, config: unknown): FilterId[] {
    const switches = isRecord(config) ? config : null;
    const ids = scope === 'person' ? PERSON_FILTERS : scope === 'loaded' ? LOADED_FILTERS : FEED_FILTERS;
    return ids.filter(id => switches?.[FILTER_SWITCHES[id]] !== false);
}

/** Whether a range has either bound typed. */
const isRangeSet = (range: Range | undefined): boolean => !!range && (range[0] !== '' || range[1] !== '');

/** How many filters are narrowing the list. */
export function activeFilterCount(selection: FilterSelection | null | undefined): number {
    const chosen = selection || {};
    return RANGE_IDS.map(id => chosen[id]).filter(isRangeSet).length
        + LIST_IDS.map(id => chosen[id]).filter(list => !!list && list.length > 0).length;
}

/** Whether a list is matched by all of what is ticked or any of it. */
export function matchOf(selection: FilterSelection | null | undefined, id: MatchId): Match {
    const chosen = selection?.match?.[id];
    return chosen === 'all' || chosen === 'any' ? chosen : MATCH_DEFAULTS[id];
}

/**
 * A feed's request where its route already names a list (a genre's page, a tag's), and what is kept of its titles
 * here. The route's own genre is always asked for. The other genres ticked are added to it as all of them (Seerr joins
 * the route's genre and that list with a comma); matched by any, they are kept here instead, by the genres each title
 * has, since TMDB can't say "this genre and any of those" in one request. A tag's own keyword can only be added to as
 * all of them: a title does not say its keywords. `query`: what the filters add (`&name=value` pairs, as
 * feedFilterQuery gives them).
 */
export function routeFeed(path: string, kind: FeedKind, selection: FilterSelection | null | undefined, query: string): RoutedFeed {
    let asked = query;
    let keep: ((item: SeerrResult) => boolean) | null = null;
    const ownGenre = GENRE_ROUTE.exec(path)?.[1];
    if (ownGenre && matchOf(selection, 'genres') === 'any') {
        const ticked = (selection?.genres ?? []).map(genre => genreIdFor(genre, kind)).filter(id => id !== ownGenre);
        const others = ticked.filter(id => id !== '');
        if (ticked.length > 0) {
            asked = asked.replace(/&genre=[^&]*/, '');
            // Ticked, but none of this kind's genres: nothing of this kind is in any of them (see feedFilterQuery).
            if (others.length === 0) asked += `&${kind === 'tv' ? 'firstAirDate' : 'primaryReleaseDate'}Lte=1800-01-01`;
            else keep = item => Array.isArray(item?.genreIds) && item.genreIds.some(id => others.includes(String(id)));
        }
    }
    if (KEYWORD_ROUTE.test(path)) asked = asked.replace(/(&keywords=)([^&]*)/, (_, name: string, value: string) => name + value.replace(/%7C/gi, '%2C'));
    // What a title must not be is kept here, on every feed (Seerr can only leave out keywords).
    const allowed = notExcluded(selection, kind);
    if (allowed) {
        const kept = keep;
        keep = kept ? item => kept(item) && allowed(item) : allowed;
    }
    return { query: asked, keep };
}

/**
 * What a title must not be, checked by what it says of itself: in none of the genres under Without genres, and
 * originally in none of the languages under Without language. Null when neither is set. `kind`: the feed's kind
 * (none: each title's own).
 */
function notExcluded(selection: FilterSelection | null | undefined, kind?: FeedKind): ((item: SeerrResult) => boolean) | null {
    const genres = selection?.withoutGenres ?? [];
    const languages = new Set((selection?.withoutLanguage ?? []).map(language => language.id));
    if (genres.length === 0 && languages.size === 0) return null;
    return item => {
        const own = Array.isArray(item?.genreIds) ? item.genreIds.map(String) : [];
        const itemKind: FeedKind = kind ?? (item?.mediaType === 'tv' ? 'tv' : 'movie');
        if (genres.some(genre => { const id = genreIdFor(genre, itemKind); return id !== '' && own.includes(id); })) return false;
        return !(languages.size > 0 && typeof item?.originalLanguage === 'string' && languages.has(item.originalLanguage));
    };
}

/** Whether every filter set can be checked on loaded titles (keepByFilters): none of runtime, rating, services, keywords or role is set. */
export function checkableOnLoaded(selection: FilterSelection | null | undefined): boolean {
    const chosen = selection || {};
    return !isRangeSet(chosen.runtime)
        && [chosen.role, chosen.rating, chosen.services, chosen.keywords, chosen.without].every(list => !list || list.length === 0);
}

/**
 * What is typed for a year: a year, a month of one, or a day. The first day it covers, or the last
 * (`last`), as YYYY-MM-DD, or null when it is none of those.
 */
export function dayOf(text: string, last: boolean): string | null {
    const typed = String(text ?? '').trim();
    if (/^\d{4}$/.test(typed)) return `${typed}-${last ? '12-31' : '01-01'}`;
    const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(typed);
    // (Day 0 of the next month is the last day of this one.)
    if (month) return `${typed}-${last ? String(new Date(Date.UTC(Number(month[1]), Number(month[2]), 0)).getUTCDate()).padStart(2, '0') : '01'}`;
    return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(typed) ? typed : null;
}

/** A typed number within a filter's own limits, or null: a score is 0 to 10 and may have a decimal, the others are whole. */
export function numberOf(id: RangeId, text: string): number | null {
    const typed = String(text ?? '').trim().replace(',', '.');
    if (id === 'score') {
        const score = /^\d{1,2}(\.\d)?$/.test(typed) ? Number(typed) : NaN;
        return score >= 0 && score <= 10 ? score : null;
    }
    return /^\d{1,7}$/.test(typed) ? Number(typed) : null;
}

/** Whether what is typed for one bound can be used ('' can: it is no bound). `upper`: the upper bound. */
export function isBound(id: RangeId, text: string, upper: boolean): boolean {
    return String(text ?? '').trim() === '' || (id === 'year' ? dayOf(text, upper) !== null : numberOf(id, text) !== null);
}

/** Whether both bounds are typed, each can be used, and the lower one is past the upper: a range nothing is in. */
export function isReversed(id: RangeId, range: Range): boolean {
    const [from, to] = range;
    if (from.trim() === '' || to.trim() === '') return false;
    if (id === 'year') {
        const first = dayOf(from, false);
        const last = dayOf(to, true);
        return first !== null && last !== null && first > last;
    }
    const low = numberOf(id, from);
    const high = numberOf(id, to);
    return low !== null && high !== null && low > high;
}

/** A genre's own TMDB id for one kind ('' where TMDB has no such genre for that kind). */
const genreIdFor = (genre: Picked, kind: FeedKind): string => genre.id.split('/')[kind === 'movie' ? 0 : 1] ?? '';

/**
 * What a selection adds to a feed's request, as `&name=value` pairs in a fixed order (the request
 * is also the cache key). Seerr dates a movie by its release and a series by its first air date,
 * and takes "all of" as a comma and "any of" as a bar.
 */
export function feedFilterQuery(selection: FilterSelection | null | undefined, kind: FeedKind, region: string): string {
    const chosen = selection || {};
    const pairs: Array<[string, string]> = [];
    const date = kind === 'tv' ? 'firstAirDate' : 'primaryReleaseDate';
    const anyGenre = matchOf(chosen, 'genres') === 'any';
    const allGenres = (chosen.genres ?? []).map(genre => genreIdFor(genre, kind));
    // A genre TMDB does not have for this kind: nothing of this kind is in all of them (Seerr has no way to say
    // "nothing", so the feed is asked for a time nothing was released in), and it adds nothing to "any of them".
    const genres = anyGenre ? allGenres.filter(Boolean) : allGenres;
    if (genres.includes('') || (anyGenre && allGenres.length > 0 && genres.length === 0)) return `&${date}Lte=1800-01-01`;
    const from = chosen.year ? dayOf(chosen.year[0], false) : null;
    const to = chosen.year ? dayOf(chosen.year[1], true) : null;
    if (from) pairs.push([`${date}Gte`, from]);
    if (to) pairs.push([`${date}Lte`, to]);
    for (const id of ['score', 'votes', 'runtime'] as const) {
        const range = chosen[id];
        const low = range ? numberOf(id, range[0]) : null;
        const high = range ? numberOf(id, range[1]) : null;
        if (low !== null) pairs.push([`${RANGE_PARAMS[id]}Gte`, String(low)]);
        if (high !== null) pairs.push([`${RANGE_PARAMS[id]}Lte`, String(high)]);
    }
    // Seerr takes "all of" as a comma and "any of" as a bar.
    const join = (id: MatchId): string => matchOf(chosen, id) === 'any' ? '|' : ',';
    if (genres.length > 0) pairs.push(['genre', genres.join(join('genres'))]);
    if (chosen.language?.length) pairs.push(['language', chosen.language.map(language => language.id).join('|')]);
    const ratings = (chosen.rating ?? []).map(rating => rating.id.split(':')).filter(parts => parts[0] === kind && parts.length === 3);
    // Ratings are ticked, but none of this kind's: nothing of this kind is wanted (see the genres above).
    if (chosen.rating?.length && ratings.length === 0) return `&${date}Lte=1800-01-01`;
    if (ratings.length > 0) {
        pairs.push(['certification', ratings.map(parts => parts[2] ?? '').join('|')], ['certificationCountry', ratings[0]?.[1] ?? 'US']);
    }
    if (chosen.services?.length) pairs.push(['watchProviders', chosen.services.map(service => service.id).join(join('services'))], ['watchRegion', region]);
    if (chosen.keywords?.length) pairs.push(['keywords', chosen.keywords.map(keyword => keyword.id).join(join('keywords'))]);
    if (chosen.without?.length) pairs.push(['excludeKeywords', chosen.without.map(keyword => keyword.id).join(',')]);
    return pairs.map(([name, value]) => `&${name}=${encodeURIComponent(value)}`).join('');
}

/**
 * A person's titles a selection keeps (and titles of a feed that takes no filters). A title with no date is outside
 * every period, one with no score or votes is under every minimum, and one must be in every genre chosen (any of them,
 * where the genres are matched by any) and in none left out.
 */
export function keepByFilters(results: SeerrResult[], selection: FilterSelection | null | undefined): SeerrResult[] {
    const chosen = selection || {};
    if (activeFilterCount(chosen) === 0) return results;
    const from = chosen.year ? dayOf(chosen.year[0], false) : null;
    const to = chosen.year ? dayOf(chosen.year[1], true) : null;
    const bounds = (['score', 'votes'] as const).map(id => {
        const range = chosen[id];
        return [id, range ? numberOf(id, range[0]) : null, range ? numberOf(id, range[1]) : null] as const;
    });
    const languages = new Set((chosen.language ?? []).map(language => language.id));
    const allowed = notExcluded(chosen);
    return results.filter(item => {
        if (allowed && !allowed(item)) return false;
        // Any of the roles ticked: a part played, or a job in one of the departments.
        if (chosen.role?.length && !chosen.role.some(role => role.id === 'cast'
            ? item.jeCredit?.acted === true : item.jeCredit?.departments?.includes(role.id) === true)) return false;
        if (from || to) {
            const date = (typeof item.releaseDate === 'string' && item.releaseDate ? item.releaseDate
                : typeof item.firstAirDate === 'string' ? item.firstAirDate : '').slice(0, 10);
            if (!date || (from && date < from) || (to && date > to)) return false;
        }
        for (const [id, low, high] of bounds) {
            const value = Number(id === 'score' ? item.voteAverage : item.voteCount) || 0;
            if ((low !== null && value < low) || (high !== null && value > high)) return false;
        }
        if (chosen.genres?.length) {
            const own = Array.isArray(item.genreIds) ? item.genreIds.map(String) : [];
            const kind = item.mediaType === 'tv' ? 'tv' : 'movie';
            const has = (genre: Picked): boolean => own.includes(genreIdFor(genre, kind)) && genreIdFor(genre, kind) !== '';
            if (!(matchOf(chosen, 'genres') === 'any' ? chosen.genres.some(has) : chosen.genres.every(has))) return false;
        }
        return languages.size === 0 || (typeof item.originalLanguage === 'string' && languages.has(item.originalLanguage));
    });
}

/** What a person did across their titles, as the Role list offers it: acting first, then each crew department, the most credits first, the catch-all last. */
export function rolesOf(results: readonly SeerrResult[], actingName: string, nameOf: (department: string) => string): Picked[] {
    const counts = new Map<string, number>();
    let acted = 0;
    for (const item of results || []) {
        if (item.jeCredit?.acted) acted++;
        for (const department of item.jeCredit?.departments ?? []) counts.set(department, (counts.get(department) ?? 0) + 1);
    }
    // (TMDB's catch-all department, "Crew", comes after every named one.)
    const crew = Array.from(counts).sort((a, b) => Number(a[0] === 'Crew') - Number(b[0] === 'Crew') || b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([id]) => ({ id, name: nameOf(id) }));
    return acted > 0 ? [{ id: 'cast', name: actingName }, ...crew] : crew;
}
