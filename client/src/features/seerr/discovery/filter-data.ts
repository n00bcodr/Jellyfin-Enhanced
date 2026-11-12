// The lists the further filters offer, asked of Seerr through the plugin's server (which has them from
// TMDB) the first time each is opened, and kept for the visit. Nothing there holds a title.
import type { FeedKind, FilterData, FilterDataDependencies, Picked, RatingList } from './types';

const FILTERS_API = '/JellyfinEnhanced/jellyseerr/filters';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
/** The object rows of what should be a list. */
const rowsOf = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value : []).filter(isRecord);
const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

/** The lists the further filters offer, each asked for once per visit. */
export function createFilterData({ region, fetch, fetchGenres }: FilterDataDependencies): FilterData {
    // One request per list for the visit; a failed one is asked again the next time the list opens.
    let genres: Promise<Picked[]> | null = null;
    let languages: Promise<Picked[]> | null = null;
    let ratings: Promise<RatingList[]> | null = null;
    let services: Promise<Picked[]> | null = null;
    /** The list already asked for, or a new request that is forgotten should it fail. */
    const once = <T>(held: Promise<T> | null, load: () => Promise<T>, forget: () => void): Promise<T> => {
        if (held) return held;
        const asked = load();
        asked.catch(forget);
        return asked;
    };

    /** Every genre TMDB has, by name: a genre's id is `<movie id>/<tv id>`, either side empty where that kind has none. */
    async function loadGenres(): Promise<Picked[]> {
        const [movie, tv] = await Promise.all([fetchGenres('movie'), fetchGenres('tv')]);
        const ids = new Map<string, { name: string; movie: string; tv: string }>();
        for (const [list, kind] of [[movie, 'movie'], [tv, 'tv']] as Array<[unknown, FeedKind]>) {
            for (const genre of rowsOf(list)) {
                if (typeof genre.name !== 'string') continue;
                const entry = ids.get(genre.name.toLowerCase()) ?? { name: genre.name, movie: '', tv: '' };
                entry[kind] = String(genre.id);
                ids.set(genre.name.toLowerCase(), entry);
            }
        }
        return Array.from(ids.values(), entry => ({ id: `${entry.movie}/${entry.tv}`, name: entry.name })).sort(byName);
    }
    /** Every language TMDB knows, named in the viewer's language where the browser can, in English otherwise. */
    async function loadLanguages(locale: string): Promise<Picked[]> {
        let names: Intl.DisplayNames | null = null;
        try { names = new Intl.DisplayNames([locale || 'en'], { type: 'language' }); } catch { names = null; }
        const list: Picked[] = [];
        const taken = new Set<string>();
        for (const row of rowsOf(await fetch(`${FILTERS_API}/languages`))) {
            const code = typeof row.iso_639_1 === 'string' ? row.iso_639_1 : '';
            // "xx" is TMDB's "no language"; the browser names an unknown code by the code itself.
            if (!/^[a-z]{2}$/.test(code) || code === 'xx') continue;
            const english = typeof row.english_name === 'string' ? row.english_name.trim() : '';
            let name = '';
            try { name = names?.of(code) ?? ''; } catch { name = ''; }
            if (!name || name === code) name = english;
            // Two codes the browser gives one name (it names Twi "Akan"): the later one keeps TMDB's own name.
            if (taken.has(name.toLowerCase())) name = english;
            if (!name || taken.has(name.toLowerCase())) continue;
            taken.add(name.toLowerCase());
            list.push({ id: code, name });
        }
        return list.sort(byName);
    }
    /** The content ratings of the region's country, or of the US where TMDB has none for it, mildest first, movies then series. */
    async function loadRatings(): Promise<RatingList[]> {
        const lists: RatingList[] = [];
        for (const kind of ['movie', 'tv'] as const) {
            const body = await fetch(`${FILTERS_API}/certifications/${kind}`);
            const all = isRecord(body) && isRecord(body.certifications) ? body.certifications : {};
            const country = rowsOf(all[region]).length > 0 ? region : 'US';
            const own = rowsOf(all[country])
                .filter(row => typeof row.certification === 'string' && row.certification !== '')
                .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
                .map(row => ({ id: `${kind}:${country}:${String(row.certification)}`, name: String(row.certification) }));
            if (own.length > 0) lists.push({ kind, ratings: own });
        }
        return lists;
    }
    /** Every service TMDB lists for the region, movies' and series' together, the widest known first. */
    async function loadServices(): Promise<Picked[]> {
        const found = new Map<string, { name: string; rank: number }>();
        const bodies = await Promise.all((['movie', 'tv'] as const).map(kind => fetch(`${FILTERS_API}/watchproviders/${kind}?watchRegion=${region}`)));
        for (const row of bodies.flatMap(rowsOf)) {
            const id = String(row.id ?? '');
            if (!/^\d+$/.test(id) || typeof row.name !== 'string' || found.has(id)) continue;
            found.set(id, { name: row.name.trim(), rank: Number(row.displayPriority) || 0 });
        }
        return Array.from(found, ([id, entry]) => ({ id, ...entry }))
            .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
            .map(({ id, name }) => ({ id, name }));
    }

    return {
        region,
        genres: () => genres = once(genres, loadGenres, () => { genres = null; }),
        languages: locale => languages = once(languages, () => loadLanguages(locale), () => { languages = null; }),
        ratings: () => ratings = once(ratings, loadRatings, () => { ratings = null; }),
        services: () => services = once(services, loadServices, () => { services = null; }),
        /** The keywords TMDB has for what is typed; `signal` ends the request when a newer search starts. */
        async searchKeywords(query, signal) {
            const body = await fetch(`/JellyfinEnhanced/tmdb/search/keyword?query=${encodeURIComponent(query)}`, { signal });
            return rowsOf(isRecord(body) ? body.results : null)
                .filter(row => typeof row.name === 'string' && /^\d+$/.test(String(row.id ?? '')))
                .map(row => ({ id: String(row.id), name: String(row.name) }));
        }
    };
}
