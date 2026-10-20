/**
 * @file Requests & downloads, phase 4c3b: what list authoring knows about titles. Pure conversion and policy: no
 * network, DOM, listener or timer, here or on load, no provider calls, no importer transport, no secrets and no cache of
 * provider payloads.
 *
 * - Search uses the household's existing route: JE households `acquire/search` (TMDB through the server, filtered for
 *   the caller), Seerr households the Seerr search proxy. Import being on or off changes neither. A person JE search
 *   refuses (a Watcher; a Kid where search is hidden) gets custom entries only, with the reason; no role is widened.
 * - Results become typed candidates `{source, identity: {mediaType, tmdbId[, tvdbId]} | null, title, year,
 *   releaseDate, posterPath, inLibrary, inert}`. An arr lookup result without a TMDB id is inert: it can fill a custom
 *   entry's words, never an acquisition identity.
 * - Season and episode facts come only from the producer's typed contract: `complete` (with an explicit count that
 *   matches), `partial` (usable, never cached, never read as all there is) or `unavailable` (with a reason). A raw
 *   provider payload, an empty or unproven answer is unavailable, never "zero seasons". JE-only season/episode
 *   enumeration is a pending producer read: without it seasons are unavailable.
 * - {@link factCache}: complete facts only, keyed by the person (session epoch, user, server), policy and source;
 *   bounded.
 *
 * Internal: lp.metadata { searchSource, searchPath, searchOutcome, searchGroups, fromJe, fromSeerr, fromArr,
 * seasonFacts, episodeFacts, readSeasons, readEpisodes, factCache }.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.arrListPages = JE.internals.arrListPages || {};

    /** The JE search route's longest query. */
    const MAX_QUERY = 100;
    const POSTER_RE = /^\/[A-Za-z0-9_-]+\.(jpg|png)$/;
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

    /** @param {*} v Value. @returns {boolean} A positive integer. */
    const positive = v => Number.isInteger(v) && v > 0;
    /** @param {*} path Poster path. @returns {string|null} A plain TMDB poster path. */
    const poster = path => (typeof path === 'string' && POSTER_RE.test(path) ? path : null);
    /** @param {*} value Date. @returns {string|null} yyyy-MM-dd. */
    const date = value => (typeof value === 'string' && DATE_RE.test(value.slice(0, 10)) ? value.slice(0, 10) : null);
    /** @param {*} value Year. @returns {number|null} A plausible year. */
    const year = value => (Number.isInteger(value) && value >= 1870 && value <= 2100 ? value : null);

    /**
     * Which search a household has.
     * @param {{backend?: string}|null} caps The person's request capabilities (JE.arrAsk.me()).
     * @returns {'je'|'seerr'|'none'} Source.
     */
    function searchSource(caps) {
        return caps?.backend === 'je' ? 'je' : caps?.backend === 'seerr' ? 'seerr' : 'none';
    }

    /**
     * The existing route of a search (under /JellyfinEnhanced), or null when there is none to ask.
     * @param {'je'|'seerr'|'none'} source Source.
     * @param {string} query Query.
     * @param {string} lang Language.
     * @returns {string|null} Path.
     */
    function searchPath(source, query, lang) {
        const q = String(query ?? '').trim();
        if (!q || q.length > MAX_QUERY) return null;
        const language = encodeURIComponent(String(lang || 'en'));
        if (source === 'je') return `/acquire/search?q=${encodeURIComponent(q)}&page=1&language=${language}`;
        if (source === 'seerr') return `/jellyseerr/search?query=${encodeURIComponent(q)}&page=1&language=${language}`;
        return null;
    }

    /**
     * A candidate.
     * @returns {Object} Candidate.
     */
    function candidate(source, mediaType, tmdbId, fields) {
        return {
            source,
            identity: { mediaType, tmdbId },
            title: String(fields.title || '').trim(),
            year: year(fields.year) ?? (fields.releaseDate ? Number(fields.releaseDate.slice(0, 4)) : null),
            releaseDate: fields.releaseDate || null,
            posterPath: poster(fields.posterPath),
            inLibrary: fields.inLibrary === true,
            inert: false
        };
    }

    /**
     * A JE search card as a candidate.
     * @param {Object} card DiscoverCard ({kind, tmdbId, title, year, poster, inLibrary}).
     * @returns {Object|null} Candidate.
     */
    function fromJe(card) {
        if (!card || (card.kind !== 'movie' && card.kind !== 'tv') || !positive(card.tmdbId) || !card.title) return null;
        return candidate('je', card.kind, card.tmdbId, { title: card.title, year: card.year, posterPath: card.poster, inLibrary: card.inLibrary });
    }

    /**
     * A Seerr search result as a candidate.
     * @param {Object} result Seerr result ({id, mediaType, title|name, releaseDate|firstAirDate, posterPath, mediaInfo}).
     * @returns {Object|null} Candidate.
     */
    function fromSeerr(result) {
        if (!result || (result.mediaType !== 'movie' && result.mediaType !== 'tv') || !positive(result.id)) return null;
        const title = result.title || result.name;
        if (!title) return null;
        const released = date(result.mediaType === 'tv' ? (result.firstAirDate || result.releaseDate) : (result.releaseDate || result.firstAirDate));
        const inLibrary = !!result.mediaInfo?.jellyfinMediaId && (result.mediaInfo.status === 4 || result.mediaInfo.status === 5);
        return candidate('seerr', result.mediaType, result.id, { title, releaseDate: released, posterPath: result.posterPath, inLibrary });
    }

    /**
     * An admin arr lookup result as a candidate: inert (custom words only) without a TMDB id.
     * @param {Object} result Arr lookup result ({tmdbId?, tvdbId?, imdbId?, mediaType, title, year, posterPath?}).
     * @returns {Object|null} Candidate.
     */
    function fromArr(result) {
        if (!result || (result.mediaType !== 'movie' && result.mediaType !== 'tv') || !result.title) return null;
        if (positive(result.tmdbId)) {
            const out = candidate('arr', result.mediaType, result.tmdbId, { title: result.title, year: result.year, posterPath: result.posterPath });
            if (result.mediaType === 'tv' && positive(result.tvdbId)) out.identity.tvdbId = result.tvdbId;
            return out;
        }
        const words = { mediaType: result.mediaType, title: String(result.title).trim(), year: year(result.year) };
        if (words.year === null) delete words.year;
        return { source: 'arr', identity: null, title: words.title, year: year(result.year), releaseDate: null, posterPath: null, inLibrary: false, inert: true, custom: words };
    }

    /**
     * What a search answered.
     * @param {'je'|'seerr'|'none'} source Source.
     * @param {{status: number, body: Object|null}|null} answer Answer.
     * @returns {{state: 'results', items: Object[]}|{state: 'custom_only'|'unavailable', reason: string}} Outcome.
     */
    function searchOutcome(source, answer) {
        if (source === 'none') return { state: 'custom_only', reason: 'no_search' };
        const status = Number(answer?.status) || 0;
        const body = answer?.body || null;
        if (status === 403) {
            if (body?.reason === 'requests_create_required') return { state: 'custom_only', reason: 'watcher' };
            if (body?.reason === 'search_hidden') return { state: 'custom_only', reason: 'search_hidden' };
            return { state: 'custom_only', reason: 'denied' };
        }
        if (status !== 200) return { state: 'unavailable', reason: 'outage' };
        const results = source === 'je' ? body?.answer?.results : body?.results;
        if (!Array.isArray(results)) return { state: 'unavailable', reason: 'malformed' };
        const convert = source === 'je' ? fromJe : fromSeerr;
        return { state: 'results', items: results.map(convert).filter(Boolean) };
    }

    /**
     * The result groups of a search: the backend's, then an administrator's arr lookup when the core supplies one
     * (Seerr being off does not remove it); a missing lookup stays a pending handoff, not a dead group.
     * @param {{source: string, isAdmin: boolean, arrLookup: boolean}} info Info.
     * @returns {{groups: string[], pending: string[]}} Groups.
     */
    function searchGroups({ source, isAdmin, arrLookup }) {
        const groups = source === 'je' || source === 'seerr' ? [source] : [];
        const pending = [];
        if (isAdmin === true) (arrLookup === true ? groups : pending).push('arr');
        return { groups, pending };
    }

    /** @param {string} reason Why. @returns {{state: 'unavailable', reason: string}} Unavailable. */
    const unavailable = reason => ({ state: 'unavailable', reason });

    /**
     * Season facts from the producer's typed contract.
     * @param {*} facts {state, count?, seasons: [{seasonNumber, episodeCount, airDate?}], reason?}.
     * @returns {{state: 'complete'|'partial', seasons: Object[]}|{state: 'unavailable', reason: string}} Facts.
     */
    function seasonFacts(facts) {
        if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return unavailable('malformed');
        if (facts.state === 'unavailable') return unavailable(typeof facts.reason === 'string' ? facts.reason : 'unavailable');
        if (facts.state !== 'complete' && facts.state !== 'partial') return unavailable('malformed');
        if (!Array.isArray(facts.seasons)) return unavailable('malformed');
        const seasons = [];
        const seen = new Set();
        for (const s of facts.seasons) {
            if (!s || !Number.isInteger(s.seasonNumber) || s.seasonNumber < 0 || s.seasonNumber > 200 || !Number.isInteger(s.episodeCount) || s.episodeCount < 0 || seen.has(s.seasonNumber)) return unavailable('malformed');
            seen.add(s.seasonNumber);
            seasons.push({ seasonNumber: s.seasonNumber, episodeCount: s.episodeCount, airDate: date(s.airDate) });
        }
        if (facts.state === 'complete' && !(Number.isInteger(facts.count) && facts.count === seasons.length)) return unavailable('unproven');
        if (facts.state === 'partial' && !seasons.length) return unavailable('unproven');
        // Specials last.
        seasons.sort((a, b) => (a.seasonNumber === 0) - (b.seasonNumber === 0) || a.seasonNumber - b.seasonNumber);
        return { state: facts.state, seasons };
    }

    /**
     * Episode facts of one season from the producer's typed contract.
     * @param {*} facts {state, count?, seasonNumber, episodes: [{episodeNumber, title?, airDate?}]}.
     * @returns {{state: 'complete'|'partial', seasonNumber: number, episodes: Object[]}|{state: 'unavailable', reason: string}} Facts.
     */
    function episodeFacts(facts) {
        if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return unavailable('malformed');
        if (facts.state === 'unavailable') return unavailable(typeof facts.reason === 'string' ? facts.reason : 'unavailable');
        if ((facts.state !== 'complete' && facts.state !== 'partial') || !Number.isInteger(facts.seasonNumber) || !Array.isArray(facts.episodes)) return unavailable('malformed');
        const episodes = [];
        const seen = new Set();
        for (const ep of facts.episodes) {
            if (!ep || !Number.isInteger(ep.episodeNumber) || ep.episodeNumber < 0 || ep.episodeNumber > 9999 || seen.has(ep.episodeNumber)) return unavailable('malformed');
            seen.add(ep.episodeNumber);
            episodes.push({ e: ep.episodeNumber, title: typeof ep.title === 'string' && ep.title ? ep.title : null, airDate: date(ep.airDate) });
        }
        if (facts.state === 'complete' && !(Number.isInteger(facts.count) && facts.count === episodes.length)) return unavailable('unproven');
        if (!episodes.length) return unavailable('unproven');
        episodes.sort((a, b) => a.e - b.e);
        return { state: facts.state, seasonNumber: facts.seasonNumber, episodes };
    }

    /**
     * Reads facts through the producer's read (injected; absent until the producer lands).
     * @param {function(...*): Promise<{status: number, body: *}>|undefined} read The read.
     * @param {Array} args Its arguments.
     * @param {function(*): Object} typed Conversion.
     * @returns {Promise<Object>} Typed facts.
     */
    async function readFacts(read, args, typed) {
        if (typeof read !== 'function') return unavailable('producer_missing');
        let answer;
        try {
            answer = await read(...args);
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            return unavailable('outage');
        }
        const status = Number(answer?.status) || 0;
        if (status === 401 || status === 403 || status === 404) return unavailable('denied');
        if (status !== 200) return unavailable('outage');
        return typed(answer.body);
    }

    /**
     * A show's season facts.
     * @param {Function|undefined} read The producer's read (tmdbId, options) → {status, body}.
     * @param {number} tmdbId Show.
     * @param {{signal?: AbortSignal}} options Options.
     * @returns {Promise<Object>} Season facts.
     */
    const readSeasons = (read, tmdbId, options) => readFacts(read, [tmdbId, options], seasonFacts);

    /**
     * A season's episode facts.
     * @param {Function|undefined} read The producer's read (tmdbId, season, options) → {status, body}.
     * @param {number} tmdbId Show.
     * @param {number} season Season.
     * @param {{signal?: AbortSignal}} options Options.
     * @returns {Promise<Object>} Episode facts.
     */
    const readEpisodes = (read, tmdbId, season, options) => readFacts(read, [tmdbId, season, options], episodeFacts);

    /**
     * Who is asking now: the session's epoch, user and server.
     * @returns {string} Identity key.
     */
    function viewer() {
        const s = JE.session;
        return [s?.getEpoch?.() ?? 0, s?.getUserId?.() ?? '', s?.getServerId?.() ?? ''].join('|');
    }

    /**
     * A bounded cache of complete facts.
     * @param {number} [max] Most entries.
     * @returns {{admit: Function, get: Function, size: function(): number}} Cache.
     */
    function factCache(max = 64) {
        /** @type {Map<string, Object>} */
        const entries = new Map();
        const keyOf = (key, scope) => [viewer(), scope?.source ?? '', scope?.policy ?? '', key].join('\u0000');
        return {
            /** Keeps complete facts only. @returns {boolean} Kept. */
            admit(key, scope, facts) {
                if (facts?.state !== 'complete') return false;
                const k = keyOf(key, scope);
                entries.delete(k);
                if (entries.size >= max) entries.delete(entries.keys().next().value);
                entries.set(k, facts);
                return true;
            },
            /** @returns {Object|null} Facts kept for this person, scope and key. */
            get(key, scope) {
                return entries.get(keyOf(key, scope)) || null;
            },
            size: () => entries.size
        };
    }

    lp.metadata = Object.freeze({
        MAX_QUERY, searchSource, searchPath, searchOutcome, searchGroups, fromJe, fromSeerr, fromArr, seasonFacts, episodeFacts,
        readSeasons, readEpisodes, factCache
    });
})(window.JellyfinEnhanced);
