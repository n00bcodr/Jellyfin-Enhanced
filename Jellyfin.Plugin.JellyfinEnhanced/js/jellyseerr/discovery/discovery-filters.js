// /js/jellyseerr/discovery/discovery-filters.js
// The further filters of a discovery section (beyond All / Movies / Series): what can be set, what
// a selection asks of Seerr's feeds on a list page, and what it keeps of a person's titles (which
// are all loaded already, so they are filtered here). Pure: no document, no network.
//
// Nothing is offered as a short list of presets where the viewer could mean something else: a
// range is typed (a year or a date, a score, a number of votes, minutes), and a list is the whole
// list (every genre, every language, every service of the region, any keyword).
//
// Also the lists the further filters offer (createFilterData), asked of Seerr through the plugin's
// server (which has them from TMDB) the first time each is opened, and kept for the visit. Nothing
// there holds a title.
//
// Shapes (as the rewrite typed them):
// - scope: 'feed' (a list page's section, filtered by Seerr) or 'person' (a person's titles, filtered here).
// - Picked: { id, name }: one thing picked from a list: what it is to Seerr (see each list below), and its name for the eye.
// - Range: [from, to]: what was typed as the lower and the upper bound; '' for none.
// - FilterSelection: { role?, year?, score?, votes?, runtime?, genres?, language?, rating?, services?, keywords?, without? }
//   - role: Picked[]: what the person did: `cast` for a part played, or a crew department by TMDB's name ("Directing").
//   - year, score, votes, runtime: Range.
//   - genres: Picked[]: a genre's id is `<movie id>/<tv id>`: TMDB numbers its movie and its series genres apart, and has some for one kind only.
//   - language: Picked[]: a language's id is its two-letter code.
//   - rating: Picked[]: a content rating's id is `<movie|tv>:<country>:<rating>`.
//   - services: Picked[]: a service's id is TMDB's provider id.
//   - keywords, without: Picked[]: a keyword's id is TMDB's keyword id.
(function(JE) {
    'use strict';

    const FEED_FILTERS = ['year', 'score', 'votes', 'runtime', 'genres', 'language', 'rating', 'services', 'keywords', 'without'];
    /** A person's credits carry no runtime, rating, services or keywords: those are not offered there. */
    const PERSON_FILTERS = ['role', 'year', 'score', 'votes', 'genres', 'language'];
    /** The admin's switch for each filter (the two keyword filters share one). */
    const FILTER_SWITCHES = Object.freeze({
        role: 'JellyseerrFilterRole', year: 'JellyseerrFilterYear', score: 'JellyseerrFilterScore', votes: 'JellyseerrFilterVotes',
        runtime: 'JellyseerrFilterRuntime', genres: 'JellyseerrFilterGenres', language: 'JellyseerrFilterLanguage',
        rating: 'JellyseerrFilterContentRating', services: 'JellyseerrFilterStreaming', keywords: 'JellyseerrFilterKeywords',
        without: 'JellyseerrFilterKeywords'
    });
    const RANGE_IDS = ['year', 'score', 'votes', 'runtime'];
    const LIST_IDS = ['role', 'genres', 'language', 'rating', 'services', 'keywords', 'without'];

    /**
     * The filters a section of this scope offers, in the order they are shown, less the ones the admin turned off.
     * @param {'feed'|'person'} scope - A list page's section, or a person's titles
     * @param {object|null|undefined} config - The plugin's public config (a missing switch means on)
     * @returns {string[]} The filter ids offered
     */
    function offeredFilters(scope, config) {
        return (scope === 'person' ? PERSON_FILTERS : FEED_FILTERS).filter(id => config?.[FILTER_SWITCHES[id]] !== false);
    }

    /**
     * Whether a range has either bound typed.
     * @param {string[]|undefined} range - [from, to]
     * @returns {boolean}
     */
    const isRangeSet = range => !!range && (range[0] !== '' || range[1] !== '');

    /**
     * How many filters are narrowing the list.
     * @param {object} selection - The section's FilterSelection
     * @returns {number}
     */
    function activeFilterCount(selection) {
        const chosen = selection || {};
        return RANGE_IDS.map(id => chosen[id]).filter(isRangeSet).length
            + LIST_IDS.map(id => chosen[id]).filter(list => !!list && list.length > 0).length;
    }

    /**
     * What is typed for a year: a year, a month of one, or a day. The first day it covers, or the last.
     * @param {string} text - What was typed
     * @param {boolean} last - The last day it covers (else the first)
     * @returns {string|null} The day as YYYY-MM-DD, or null when it is none of those
     */
    function dayOf(text, last) {
        const typed = String(text ?? '').trim();
        if (/^\d{4}$/.test(typed)) return `${typed}-${last ? '12-31' : '01-01'}`;
        const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(typed);
        // (Day 0 of the next month is the last day of this one.)
        if (month) return `${typed}-${last ? String(new Date(Date.UTC(Number(month[1]), Number(month[2]), 0)).getUTCDate()).padStart(2, '0') : '01'}`;
        return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(typed) ? typed : null;
    }

    /**
     * A typed number within a filter's own limits, or null: a score is 0 to 10 and may have a decimal, the others are whole.
     * @param {'score'|'votes'|'runtime'} id - The range filter
     * @param {string} text - What was typed
     * @returns {number|null}
     */
    function numberOf(id, text) {
        const typed = String(text ?? '').trim().replace(',', '.');
        if (id === 'score') {
            const score = /^\d{1,2}(\.\d)?$/.test(typed) ? Number(typed) : NaN;
            return score >= 0 && score <= 10 ? score : null;
        }
        return /^\d{1,7}$/.test(typed) ? Number(typed) : null;
    }

    /**
     * Whether what is typed for one bound can be used ('' can: it is no bound).
     * @param {'year'|'score'|'votes'|'runtime'} id - The range filter
     * @param {string} text - What was typed
     * @param {boolean} upper - The upper bound (else the lower)
     * @returns {boolean}
     */
    function isBound(id, text, upper) {
        return String(text ?? '').trim() === '' || (id === 'year' ? dayOf(text, upper) !== null : numberOf(id, text) !== null);
    }

    /**
     * Whether both bounds are typed, each can be used, and the lower one is past the upper: a range nothing is in.
     * @param {'year'|'score'|'votes'|'runtime'} id - The range filter
     * @param {string[]} range - [from, to] as typed
     * @returns {boolean}
     */
    function isReversed(id, range) {
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

    const RANGE_PARAMS = Object.freeze({ score: 'voteAverage', votes: 'voteCount', runtime: 'withRuntime' });

    /**
     * A genre's own TMDB id for one kind ('' where TMDB has no such genre for that kind).
     * @param {{id: string}} genre - A picked genre (`<movie id>/<tv id>`)
     * @param {'movie'|'tv'} kind - The feed's kind
     * @returns {string}
     */
    const genreIdFor = (genre, kind) => genre.id.split('/')[kind === 'movie' ? 0 : 1] ?? '';

    /**
     * What a selection adds to a feed's request, as `&name=value` pairs in a fixed order (the request
     * is also the cache key). Seerr dates a movie by its release and a series by its first air date,
     * and takes "all of" as a comma and "any of" as a bar.
     * @param {object} selection - The section's FilterSelection
     * @param {'movie'|'tv'} kind - The feed's kind
     * @param {string} region - The region whose services are asked for
     * @returns {string} The query to append ('' for none)
     */
    function feedFilterQuery(selection, kind, region) {
        const chosen = selection || {};
        const pairs = [];
        const date = kind === 'tv' ? 'firstAirDate' : 'primaryReleaseDate';
        const genres = (chosen.genres ?? []).map(genre => genreIdFor(genre, kind));
        // A genre TMDB does not have for this kind: nothing of this kind is in it. Seerr has no way to
        // say "nothing", so the feed is asked for a time nothing was released in.
        if (genres.includes('')) return `&${date}Lte=1800-01-01`;
        const from = chosen.year ? dayOf(chosen.year[0], false) : null;
        const to = chosen.year ? dayOf(chosen.year[1], true) : null;
        if (from) pairs.push([`${date}Gte`, from]);
        if (to) pairs.push([`${date}Lte`, to]);
        for (const id of ['score', 'votes', 'runtime']) {
            const range = chosen[id];
            const low = range ? numberOf(id, range[0]) : null;
            const high = range ? numberOf(id, range[1]) : null;
            if (low !== null) pairs.push([`${RANGE_PARAMS[id]}Gte`, String(low)]);
            if (high !== null) pairs.push([`${RANGE_PARAMS[id]}Lte`, String(high)]);
        }
        if (genres.length > 0) pairs.push(['genre', genres.join(',')]);
        if (chosen.language?.length) pairs.push(['language', chosen.language.map(language => language.id).join('|')]);
        const ratings = (chosen.rating ?? []).map(rating => rating.id.split(':')).filter(parts => parts[0] === kind && parts.length === 3);
        // Ratings are ticked, but none of this kind's: nothing of this kind is wanted (see the genres above).
        if (chosen.rating?.length && ratings.length === 0) return `&${date}Lte=1800-01-01`;
        if (ratings.length > 0) {
            pairs.push(['certification', ratings.map(parts => parts[2]).join('|')], ['certificationCountry', ratings[0]?.[1] ?? 'US']);
        }
        if (chosen.services?.length) pairs.push(['watchProviders', chosen.services.map(service => service.id).join('|')], ['watchRegion', region]);
        if (chosen.keywords?.length) pairs.push(['keywords', chosen.keywords.map(keyword => keyword.id).join(',')]);
        if (chosen.without?.length) pairs.push(['excludeKeywords', chosen.without.map(keyword => keyword.id).join(',')]);
        return pairs.map(([name, value]) => `&${name}=${encodeURIComponent(value)}`).join('');
    }

    /**
     * A person's titles a selection keeps. A title with no date is outside every period, one with no
     * score or votes is under every minimum, and one must be in every genre chosen.
     * @param {object[]} results - Seerr results (a person's titles, with `jeCredit`)
     * @param {object} selection - The section's FilterSelection
     * @returns {object[]} The titles kept
     */
    function keepByFilters(results, selection) {
        const chosen = selection || {};
        if (activeFilterCount(chosen) === 0) return results;
        const from = chosen.year ? dayOf(chosen.year[0], false) : null;
        const to = chosen.year ? dayOf(chosen.year[1], true) : null;
        const bounds = ['score', 'votes'].map(id => {
            const range = chosen[id];
            return [id, range ? numberOf(id, range[0]) : null, range ? numberOf(id, range[1]) : null];
        });
        const languages = new Set((chosen.language ?? []).map(language => language.id));
        return results.filter(item => {
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
                if (!chosen.genres.every(genre => own.includes(genreIdFor(genre, kind)) && genreIdFor(genre, kind) !== '')) return false;
            }
            return languages.size === 0 || (typeof item.originalLanguage === 'string' && languages.has(item.originalLanguage));
        });
    }

    /**
     * What a person did across their titles, as the Role list offers it: acting first, then each crew department, the most credits first, the catch-all last.
     * @param {object[]} results - A person's titles, with `jeCredit`
     * @param {string} actingName - The word for acting
     * @param {(department: string) => string} nameOf - A department's name for the eye
     * @returns {{id: string, name: string}[]}
     */
    function rolesOf(results, actingName, nameOf) {
        const counts = new Map();
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

    // ---- The lists the further filters offer -------------------------------------------------

    const FILTERS_API = '/JellyfinEnhanced/jellyseerr/filters';
    /**
     * Whether a value is a plain object.
     * @param {*} value
     * @returns {boolean}
     */
    const isRecord = value => typeof value === 'object' && value !== null;
    /**
     * The object rows of what should be a list.
     * @param {*} value
     * @returns {object[]}
     */
    const rowsOf = value => (Array.isArray(value) ? value : []).filter(isRecord);
    /**
     * Orders two picked entries by name.
     * @param {{name: string}} a
     * @param {{name: string}} b
     * @returns {number}
     */
    const byName = (a, b) => a.name.localeCompare(b.name);

    /**
     * The lists the further filters offer, each asked for once per visit.
     * @param {object} dependencies
     * @param {string} dependencies.region - The region whose services and ratings are offered: the admin's default region
     * @param {(path: string, options?: object) => Promise<any>} dependencies.fetch - A managed GET
     * @param {(kind: 'movie'|'tv') => Promise<{id: number, name: string}[]>} dependencies.fetchGenres - TMDB's genre list of a kind
     * @returns {{region: string, genres: Function, languages: Function, ratings: Function, services: Function, searchKeywords: Function}}
     */
    function createFilterData({ region, fetch, fetchGenres }) {
        // One request per list for the visit; a failed one is asked again the next time the list opens.
        let genres = null;
        let languages = null;
        let ratings = null;
        let services = null;
        /**
         * The list already asked for, or a new request that is forgotten should it fail.
         * @param {Promise|null} held - The request kept for the visit
         * @param {() => Promise} load - Asks for the list
         * @param {() => void} forget - Drops the kept request
         * @returns {Promise}
         */
        const once = (held, load, forget) => {
            if (held) return held;
            const asked = load();
            asked.catch(forget);
            return asked;
        };

        /**
         * Every genre TMDB has, by name: a genre's id is `<movie id>/<tv id>`, either side empty where that kind has none.
         * @returns {Promise<{id: string, name: string}[]>}
         */
        async function loadGenres() {
            const [movie, tv] = await Promise.all([fetchGenres('movie'), fetchGenres('tv')]);
            const ids = new Map();
            for (const [list, kind] of [[movie, 'movie'], [tv, 'tv']]) {
                for (const genre of rowsOf(list)) {
                    if (typeof genre.name !== 'string') continue;
                    const entry = ids.get(genre.name.toLowerCase()) ?? { name: genre.name, movie: '', tv: '' };
                    entry[kind] = String(genre.id);
                    ids.set(genre.name.toLowerCase(), entry);
                }
            }
            return Array.from(ids.values(), entry => ({ id: `${entry.movie}/${entry.tv}`, name: entry.name })).sort(byName);
        }
        /**
         * Every language TMDB knows, named in the viewer's language where the browser can, in English otherwise.
         * @param {string} locale - The page's language
         * @returns {Promise<{id: string, name: string}[]>}
         */
        async function loadLanguages(locale) {
            let names = null;
            try { names = new Intl.DisplayNames([locale || 'en'], { type: 'language' }); } catch (_) { names = null; }
            const list = [];
            const taken = new Set();
            for (const row of rowsOf(await fetch(`${FILTERS_API}/languages`))) {
                const code = typeof row.iso_639_1 === 'string' ? row.iso_639_1 : '';
                // "xx" is TMDB's "no language"; the browser names an unknown code by the code itself.
                if (!/^[a-z]{2}$/.test(code) || code === 'xx') continue;
                const english = typeof row.english_name === 'string' ? row.english_name.trim() : '';
                let name = '';
                try { name = names?.of(code) ?? ''; } catch (_) { name = ''; }
                if (!name || name === code) name = english;
                // Two codes the browser gives one name (it names Twi "Akan"): the later one keeps TMDB's own name.
                if (taken.has(name.toLowerCase())) name = english;
                if (!name || taken.has(name.toLowerCase())) continue;
                taken.add(name.toLowerCase());
                list.push({ id: code, name });
            }
            return list.sort(byName);
        }
        /**
         * The content ratings of the region's country, or of the US where TMDB has none for it, mildest first, movies then series.
         * @returns {Promise<{kind: 'movie'|'tv', ratings: {id: string, name: string}[]}[]>}
         */
        async function loadRatings() {
            const lists = [];
            for (const kind of ['movie', 'tv']) {
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
        /**
         * Every service TMDB lists for the region, movies' and series' together, the widest known first.
         * @returns {Promise<{id: string, name: string}[]>}
         */
        async function loadServices() {
            const found = new Map();
            const bodies = await Promise.all(['movie', 'tv'].map(kind => fetch(`${FILTERS_API}/watchproviders/${kind}?watchRegion=${region}`)));
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
            /**
             * The keywords TMDB has for what is typed.
             * @param {string} query - What was typed
             * @param {AbortSignal} signal - Ends the request when a newer search starts
             * @returns {Promise<{id: string, name: string}[]>}
             */
            async searchKeywords(query, signal) {
                const body = await fetch(`/JellyfinEnhanced/tmdb/search/keyword?query=${encodeURIComponent(query)}`, { signal });
                return rowsOf(isRecord(body) ? body.results : null)
                    .filter(row => typeof row.name === 'string' && /^\d+$/.test(String(row.id ?? '')))
                    .map(row => ({ id: String(row.id), name: String(row.name) }));
            }
        };
    }

    // The panel (discovery-filter-panel.js) adds the per-section state and the controls to the same namespace.
    JE.discoveryFilters = Object.assign(JE.discoveryFilters || {}, {
        FILTER_SWITCHES,
        offeredFilters,
        activeFilterCount,
        dayOf,
        numberOf,
        isBound,
        isReversed,
        feedFilterQuery,
        keepByFilters,
        rolesOf,
        createFilterData
    });

})(window.JellyfinEnhanced || (window.JellyfinEnhanced = {}));
