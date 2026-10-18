/**
 * @file Requests & downloads lists: the import review's model and transport (track 4c2a, ported from closed PR #936's
 * import module). Preview only: nothing here changes a list.
 *
 * - Transport over /JellyfinEnhanced/acquire/lists/import: `resolve` (≤ 25 parsed entries → candidates), `fetchSource`
 *   (a list URL → entries with ids; Chronolists entries come prepared), `providers` (which sources work). Answers that
 *   arrive after a user switch are dropped.
 * - `resolveRows`: the review's resolve loop (sequential chunks of 25; busy and parental-pending answers retried; one
 *   network retry; transient entries resubmitted once, then failed; prepared rows never sent).
 * - The pure review model (`review.*`): import entries, candidates, the placeholder body of a candidate (mirrors the
 *   server's ImportPlaceholders), custom entries, default decisions, apply entries (with source keys), duplicates,
 *   counts, snapshot keys and the localised reason / error texts.
 * No DOM and no network on load: the review UI (4c2b) and the list pages and pickers (4c3) render with it.
 * Published as `JE.arrListImport` (merge-safe; the parser module adds `.parser`).
 */
(function (JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: List import:';
    const CHUNK_SIZE = 25;
    /** Most episodes one placeholder holds (ListRules.MaxEpisodes). */
    const MAX_EPISODES = 100;
    /** Most episodes an open-ended range expands to (the server's MaxOpenEndedEpisodes). */
    const MAX_EXPANDED_EPISODES = 1000;
    const MAX_SNAPSHOT_KEYS = 5000;
    const MAX_CHUNK_RETRIES = 5;
    const RETRY_DELAY_MS = 2000;
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const IMDB_RE = /^tt\d{5,10}$/;
    const ID_RE = /^[0-9a-f]{32}$/;
    const POSTER_RE = /^\/[A-Za-z0-9_-]+\.(jpg|png)$/;
    const NO_SECTION = '';
    /** Stands in for a '|' inside a translation value while tn splits the singular|plural forms (private-use char). */
    const PIPE_GUARD = '';
    /** The candidate each library-item apply entry came from (its title identity; never serialised). */
    const ENTRY_CANDIDATES = new WeakMap();

    /** Review reasons the server sends → en.json keys (unknown reasons show nothing). */
    const REASON_KEYS = {
        tba: 'arr_list_import_reason_tba',
        alternatives: 'arr_list_import_reason_alternatives',
        noYear: 'arr_list_import_reason_no_year',
        tie: 'arr_list_import_reason_tie',
        lowScore: 'arr_list_import_reason_weak',
        closeMatch: 'arr_list_import_reason_close',
        noMatch: 'arr_list_import_reason_no_match',
        notFound: 'arr_list_import_reason_no_match',
        seasonMissing: 'arr_list_import_reason_season_missing',
        episodeMissing: 'arr_list_import_reason_episode_missing',
        episodeByTitle: 'arr_list_import_reason_episode_title',
        episodeIdUnsupported: 'arr_list_import_reason_episode_id',
        typeMismatch: 'arr_list_import_reason_type',
        openEnded: 'arr_list_import_reason_open_ended',
        openEndedTruncated: 'arr_list_import_reason_open_ended_truncated',
        yearOff: 'arr_list_import_reason_year_off',
        otherYear: 'arr_list_import_reason_other_year',
        unreleased: 'arr_list_import_reason_unreleased',
        hidden: 'arr_list_import_reason_hidden',
        invalid: 'arr_list_import_reason_invalid'
    };

    /** URL read error codes → en.json keys. */
    const SOURCE_ERROR_KEYS = {
        letterboxd_unsupported: 'arr_list_import_err_letterboxd',
        unsupported_url: 'arr_list_import_err_unsupported',
        invalid_url: 'arr_list_import_err_unsupported',
        provider_disabled: 'arr_list_import_err_provider_disabled',
        trakt_not_configured: 'arr_list_import_err_trakt',
        trakt_unauthorized: 'arr_list_import_err_trakt',
        tmdb_key_required: 'arr_list_import_err_tmdb_key',
        tmdb_key_invalid: 'arr_list_import_err_tmdb_key',
        imdb_disabled: 'arr_list_import_err_imdb',
        mdblist_not_public: 'arr_list_import_err_mdblist_not_public',
        provider_pinned: 'arr_list_import_err_provider_pinned',
        source_empty: 'arr_list_import_err_source_empty',
        not_found: 'arr_list_import_err_list_not_found',
        rate_limited: 'arr_list_import_err_rate_limited',
        quota_exhausted: 'arr_list_import_err_rate_limited',
        read_budget_exhausted: 'arr_list_import_err_rate_limited',
        fetch_limited: 'arr_list_import_err_fetch_limited',
        admin_required: 'arr_list_import_err_forbidden',
        upstream_error: 'arr_list_import_err_upstream',
        unreachable: 'arr_list_import_err_upstream',
        too_large: 'arr_list_import_err_upstream',
        timeout: 'arr_list_import_err_upstream',
        source_format_changed: 'arr_list_import_err_format_changed'
    };

    /** Notices a URL read carries → en.json keys (the review must show them). */
    const NOTICE_KEYS = {
        imdb_unofficial: 'arr_list_import_notice_imdb_unofficial',
        seerr_fallback: 'arr_list_import_notice_seerr_fallback',
        mdblist_api: 'arr_list_import_notice_mdblist_api'
    };

    // ── Small shared helpers ────────────────────────────────────────────

    /**
     * Normalises a Jellyfin item id to the 32-hex "N" form the server uses.
     * @param {*} id - Id in N or D format.
     * @returns {string|null} The N-form id, or null when it isn't a GUID.
     */
    function normalizeId(id) {
        const value = String(id || '').replace(/-/g, '').toLowerCase();
        return ID_RE.test(value) ? value : null;
    }

    /**
     * A count-dependent translation: en.json keeps "singular|plural" in one string; a count of 1 picks the first form,
     * any other count the last. A '|' inside a value (a list titled "Movies | TV") stays part of the value.
     * @param {string} key - en.json key.
     * @param {Object} params - Values for the placeholders.
     * @param {string} [countKey='count'] - The param that decides the form.
     * @returns {string}
     */
    function tn(key, params, countKey = 'count') {
        const guarded = params && Object.fromEntries(Object.entries(params).map(([name, value]) => [name, typeof value === 'string' ? value.replaceAll('|', PIPE_GUARD) : value]));
        const forms = String(JE.t(key, guarded)).split('|');
        return (Number(params?.[countKey]) === 1 ? forms[0] : forms[forms.length - 1]).trim().replaceAll(PIPE_GUARD, '|');
    }

    /**
     * Whether a poster path is a plain TMDB path (same rule as the server).
     * @param {*} path
     * @returns {boolean}
     */
    function isSafePoster(path) {
        return typeof path === 'string' && POSTER_RE.test(path);
    }

    /**
     * Two-digit episode/season number.
     * @param {number} n
     * @returns {string}
     */
    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    /**
     * Compact label for an episodes entry: S01E08, S01E08–E10, S01E08, E10 or "S01 · 5 episodes".
     * @param {{seasonNumber: number, episodes: Array<{e: number}>}} ph - Placeholder-like scope.
     * @returns {string}
     */
    function episodeLabel(ph) {
        const season = Number(ph.seasonNumber) || 0;
        const numbers = (ph.episodes || []).map(e => Number(e.e)).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
        if (numbers.length === 0) return `S${pad2(season)}`;
        if (numbers.length === 1) return `S${pad2(season)}E${pad2(numbers[0])}`;
        const contiguous = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
        if (contiguous) return `S${pad2(season)}E${pad2(numbers[0])}–E${pad2(numbers[numbers.length - 1])}`;
        if (numbers.length <= 3) return `S${pad2(season)}` + numbers.map((n, i) => (i === 0 ? '' : ', ') + 'E' + pad2(n)).join('');
        return `S${pad2(season)} · ${tn('arr_list_import_episode_count', { count: numbers.length })}`;
    }

    /**
     * The en.json key of a review reason, or null.
     * @param {string} reason
     * @returns {string|null}
     */
    function reasonKey(reason) {
        return (typeof reason === 'string' && Object.prototype.hasOwnProperty.call(REASON_KEYS, reason)) ? REASON_KEYS[reason] : null;
    }

    /**
     * The text of a URL read's notice, or '' when it has none.
     * @param {string|undefined} notice
     * @returns {string}
     */
    function noticeText(notice) {
        return (typeof notice === 'string' && Object.prototype.hasOwnProperty.call(NOTICE_KEYS, notice)) ? JE.t(NOTICE_KEYS[notice]) : '';
    }

    // ── Pure helpers (exported for tests) ───────────────────────────────

    /**
     * Trims and clips a text value.
     * @param {*} value
     * @param {number} max
     * @returns {string}
     */
    function clip(value, max) {
        const text = String(value ?? '').replace(/\s+/g, ' ').trim();
        return text.length > max ? text.slice(0, max).trim() : text;
    }

    /**
     * A yyyy-MM-dd date or null.
     * @param {*} value
     * @returns {string|null}
     */
    function cleanDate(value) {
        const text = typeof value === 'string' ? value.slice(0, 10) : '';
        return DATE_RE.test(text) ? text : null;
    }

    /**
     * A year in the range the server accepts, or undefined.
     * @param {*} value
     * @returns {number|undefined}
     */
    function cleanYear(value) {
        const year = Number(value);
        return Number.isInteger(year) && year >= 1870 && year <= 2100 ? year : undefined;
    }

    /**
     * The year a pasted line gives (its year, or its date's year), or undefined.
     * @param {Object|undefined} entry - Parsed entry.
     * @returns {number|undefined}
     */
    function lineYear(entry) {
        return cleanYear(entry?.year ?? cleanDate(entry?.date)?.slice(0, 4));
    }

    /**
     * Turns a parsed (or URL-fetched) entry into the ImportEntryDto POST /resolve reads.
     * @param {Object} entry - ParsedEntry / ImportEntryDto.
     * @param {number} index - Row index echoed back by the server.
     * @returns {Object} ImportEntryDto.
     */
    function toImportEntry(entry, index) {
        const dto = { index };
        if (entry.title) dto.title = clip(entry.title, 200);
        const year = cleanYear(entry.year);
        if (year) dto.year = year;
        if (entry.typeHint === 'movie' || entry.typeHint === 'tv') dto.typeHint = entry.typeHint;
        if (Number.isInteger(entry.season)) dto.season = entry.season;
        if (Array.isArray(entry.episodes) && entry.episodes.length) dto.episodes = entry.episodes.slice(0, 100).map(e => ({ s: Number(e.s), e: Number(e.e) }));
        if (entry.openEnded) dto.openEnded = true;
        if (entry.episodeTitle) dto.episodeTitle = clip(entry.episodeTitle, 200);
        if (entry.ids && typeof entry.ids === 'object') {
            const ids = {};
            if (Number.isInteger(Number(entry.ids.tmdb)) && Number(entry.ids.tmdb) > 0) ids.tmdb = Number(entry.ids.tmdb);
            if (entry.ids.tmdbType === 'movie' || entry.ids.tmdbType === 'tv') ids.tmdbType = entry.ids.tmdbType;
            if (IMDB_RE.test(entry.ids.imdb || '')) ids.imdb = entry.ids.imdb;
            if (Number.isInteger(Number(entry.ids.tvdb)) && Number(entry.ids.tvdb) > 0) ids.tvdb = Number(entry.ids.tvdb);
            if (Object.keys(ids).length) dto.ids = ids;
        }
        if (entry.imdbEpisode) dto.imdbEpisode = true;
        if (['released', 'scheduled', 'tba'].includes(entry.status)) dto.status = entry.status;
        if (Array.isArray(entry.alternatives) && entry.alternatives.length) {
            dto.alternatives = entry.alternatives.slice(0, 4).map(alt => {
                const out = { title: clip(alt?.title, 200) };
                const altYear = cleanYear(alt?.year);
                if (altYear) out.year = altYear;
                if (alt?.typeHint === 'movie' || alt?.typeHint === 'tv') out.typeHint = alt.typeHint;
                if (Number.isInteger(alt?.season)) out.season = alt.season;
                // Its own episodes ("Flash 1x08 or Arrow 3x09"): the server never lends it the first alternative's.
                if (Array.isArray(alt?.episodes) && alt.episodes.length) out.episodes = alt.episodes.slice(0, 100).map(e => ({ s: Number(e.s), e: Number(e.e) }));
                if (alt?.openEnded && out.episodes) out.openEnded = true;
                if (alt?.ids) out.ids = toImportEntry({ ids: alt.ids }, 0).ids;
                if (!out.ids) delete out.ids;
                return out;
            });
        }
        if (entry.note) dto.note = clip(entry.note, 300);
        if (typeof entry.sourceKey === 'string' && entry.sourceKey) dto.sourceKey = entry.sourceKey;
        return dto;
    }

    /**
     * The candidates of a resolution, best first, with the match always present.
     * @param {Object|null} result - ResolvedEntryDto.
     * @returns {Array<Object>}
     */
    function candidateList(result) {
        const list = Array.isArray(result?.candidates) ? result.candidates.filter(c => c && Number(c.tmdbId) > 0) : [];
        const match = result?.match;
        if (match && Number(match.tmdbId) > 0 && !list.some(c => sameCandidate(c, match))) list.unshift(match);
        return list;
    }

    /**
     * Whether two candidates name the same title (and alternative).
     * @param {Object} a
     * @param {Object} b
     * @returns {boolean}
     */
    function sameCandidate(a, b) {
        return a.mediaType === b.mediaType && Number(a.tmdbId) === Number(b.tmdbId) && (a.alternative ?? null) === (b.alternative ?? null);
    }

    /**
     * The library item a candidate is sent as (movies everywhere; series in collections). Other TV scopes are sent as
     * placeholders: the server puts the episodes the library has in as real items and keeps the placeholder for the
     * rest (see fromLibrary).
     * @param {Object|null} cand - ImportCandidateDto.
     * @param {'playlist'|'collection'} listKind
     * @returns {string|null} The item id ("N").
     */
    function libraryItemFor(cand, listKind) {
        const lib = cand?.inLibrary;
        const id = normalizeId(lib?.itemId);
        if (!id) return null;
        if (cand.mediaType === 'movie' && lib.kind === 'movie') return id;
        if (listKind === 'collection' && cand.mediaType === 'tv' && lib.kind === 'series') return id;
        return null;
    }

    /**
     * Whether importing a candidate puts something from the library into the list: a movie or collection series item
     * (libraryItemFor), or the present episodes of a TV scope, which the server inserts as real items before a
     * placeholder that tracks the rest (collections: the Season / Episode items).
     * @param {Object|null} cand - ImportCandidateDto.
     * @param {'playlist'|'collection'} listKind
     * @returns {boolean}
     */
    function fromLibrary(cand, listKind) {
        if (libraryItemFor(cand, listKind)) return true;
        const lib = cand?.inLibrary;
        return cand?.mediaType === 'tv' && !!normalizeId(lib?.itemId) && Array.isArray(lib.episodeItemIds) && lib.episodeItemIds.length > 0;
    }

    /**
     * The "in your library" chip text of a candidate: plain for a complete match, with the episode count for a TV
     * scope the library has only part of.
     * @param {Object|null} cand - ImportCandidateDto.
     * @param {'playlist'|'collection'} listKind
     * @returns {string} Text, or '' when importing it adds nothing from the library.
     */
    function libraryChipText(cand, listKind) {
        if (!fromLibrary(cand, listKind)) return '';
        const lib = cand.inLibrary;
        const count = Array.isArray(lib.episodeItemIds) ? lib.episodeItemIds.length : 0;
        if (cand.mediaType !== 'tv' || lib.complete || !count) return JE.t('arr_list_import_in_library');
        const total = lib.kind === 'episodes' ? (cand.episodes || []).length : Number(lib.kind === 'season' ? cand.season?.episodeCount : cand.episodeTotal);
        return Number.isInteger(total) && total > count
            ? tn('arr_list_import_in_library_part', { count, total }, 'total')
            : tn('arr_list_import_in_library_episodes', { count });
    }

    /**
     * The placeholder kind a candidate stands for on this entry (mirrors the server's FromCandidate).
     * @param {Object} cand - ImportCandidateDto.
     * @param {Object} entry - Parsed entry.
     * @param {string|undefined} requested - ResolvedEntryDto.kind.
     * @returns {'movie'|'series'|'season'|'episodes'}
     */
    function kindFor(cand, entry, requested) {
        if (cand.mediaType === 'movie') return 'movie';
        if (Array.isArray(cand.episodes) && cand.episodes.length) return 'episodes';
        if (cand.season && Number.isInteger(cand.season.seasonNumber)) return requested === 'episodes' && entryEpisodes(entry, cand.season.seasonNumber).length ? 'episodes' : 'season';
        // "A S2 or B": B is the whole show unless it carries its own season (alternativeScope).
        if (cand.alternative > 0 && !entry?.alternatives?.[cand.alternative]) return 'series';
        if (requested === 'episodes' && entryEpisodes(entry, seasonOf(entry)).length) return 'episodes';
        if ((requested === 'season' || requested === 'episodes') && Number.isInteger(seasonOf(entry))) return 'season';
        return 'series';
    }

    /**
     * The part of a parsed entry a candidate answers: for an "A or B" entry the candidate's own alternative (its year,
     * season, episodes and kind), so "Flash 1x08 or Arrow 3x09" imports Arrow 3x09, not Arrow 1x08 or all of season 3.
     * @param {Object} cand - ImportCandidateDto.
     * @param {Object} entry - Parsed entry.
     * @param {string|undefined} requested - ResolvedEntryDto.kind (the first alternative's).
     * @returns {{entry: Object, requested: string|undefined}}
     */
    function alternativeScope(cand, entry, requested) {
        const alt = Number.isInteger(cand?.alternative) && Array.isArray(entry?.alternatives) ? entry.alternatives[cand.alternative] : undefined;
        if (!alt || typeof alt !== 'object') return { entry, requested };
        const episodes = Array.isArray(alt.episodes) && alt.episodes.length ? alt.episodes : undefined;
        return {
            entry: { ...entry, year: alt.year, date: alt.date, season: alt.season, episodes, openEnded: !!(episodes && alt.openEnded) },
            requested: episodes ? 'episodes' : Number.isInteger(alt.season) ? 'season' : undefined
        };
    }

    /**
     * The season a parsed entry names (season lines, or its first episode's).
     * @param {Object} entry
     * @returns {number|undefined}
     */
    function seasonOf(entry) {
        if (Number.isInteger(entry?.season)) return entry.season;
        const first = entry?.episodes?.[0];
        return first && Number.isInteger(Number(first.s)) ? Number(first.s) : undefined;
    }

    /**
     * Episode numbers a parsed entry lists for one season.
     * @param {Object} entry
     * @param {number|undefined} season
     * @returns {number[]}
     */
    function entryEpisodes(entry, season) {
        return (entry?.episodes || []).filter(e => Number(e.s) === season).map(e => Number(e.e)).filter(n => Number.isInteger(n) && n >= 0);
    }

    /**
     * Builds the placeholder body for a candidate (mirrors ImportPlaceholders.FromCandidate on the server; C4
     * release dates per kind). Returns null when the candidate can't express the entry.
     * @param {Object} cand - ImportCandidateDto.
     * @param {Object} entry - Parsed entry (season, episodes, note).
     * @param {string|undefined} requested - ResolvedEntryDto.kind.
     * @returns {Object|null} NewPlaceholderDto.
     */
    function placeholderFromCandidate(cand, entry, requested) {
        if (!cand || !(Number(cand.tmdbId) > 0) || (cand.mediaType !== 'movie' && cand.mediaType !== 'tv')) return null;
        ({ entry, requested } = alternativeScope(cand, entry, requested));
        const title = clip(cand.title, 200);
        if (!title) return null;
        const kind = kindFor(cand, entry, requested);
        const dto = { kind, mediaType: cand.mediaType, tmdbId: Number(cand.tmdbId), title };
        const release = cleanDate(cand.releaseDate);
        // TMDB has no date for the title yet (an announced title): keep the year the line gives until it has one.
        const year = cleanYear(cand.year) || (release ? undefined : lineYear(entry));
        if (year) dto.year = year;
        if (release) dto.releaseDate = release;
        if (isSafePoster(cand.posterPath)) dto.posterPath = cand.posterPath;
        if (cand.overview) dto.overview = clip(cand.overview, 1000);
        if (IMDB_RE.test(cand.imdbId || '')) dto.imdbId = cand.imdbId;
        if (cand.mediaType === 'tv' && Number(cand.tvdbId) > 0) dto.tvdbId = Number(cand.tvdbId);
        const note = clip(entry?.note, 300);
        if (note) dto.note = note;

        if (kind === 'series') {
            if (Number(cand.episodeTotal) > 0) dto.episodeTotal = Number(cand.episodeTotal);
        } else if (kind === 'season') {
            const season = Number.isInteger(cand.season?.seasonNumber) ? cand.season.seasonNumber : seasonOf(entry);
            if (!Number.isInteger(season) || season < 0 || season > 200) return null;
            dto.seasonNumber = season;
            const airDate = cleanDate(cand.season?.airDate);
            if (airDate) dto.releaseDate = airDate; else delete dto.releaseDate;
            if (Number(cand.season?.episodeCount) > 0) dto.episodeTotal = Number(cand.season.episodeCount);
        } else if (kind === 'episodes') {
            const fromCandidate = (cand.episodes || []).filter(e => Number.isInteger(Number(e.e)));
            const season = fromCandidate.length ? Number(fromCandidate[0].s) : (Number.isInteger(cand.season?.seasonNumber) ? cand.season.seasonNumber : seasonOf(entry));
            if (!Number.isInteger(season) || season < 0 || season > 200) return null;
            const info = new Map(fromCandidate.filter(e => Number(e.s) === season).map(e => [Number(e.e), e]));
            // The requested episodes, with TMDB's titles and dates where it has them (an episode TMDB doesn't list yet
            // stays tracked). Only an open-ended range ("S1E5–") takes the season's episodes the resolver expanded.
            const requested = entryEpisodes(entry, season);
            const numbers = (entry?.openEnded && info.size) || !requested.length ? Array.from(info.keys()) : requested;
            // Every episode: rowEntries splits more than one placeholder holds into consecutive placeholders.
            const unique = Array.from(new Set(numbers)).filter(n => n >= 0 && n <= 9999).sort((a, b) => a - b).slice(0, MAX_EXPANDED_EPISODES);
            if (!unique.length) return null;
            dto.seasonNumber = season;
            dto.episodes = unique.map((e) => {
                const ep = { s: season, e };
                const meta = info.get(e);
                const epTitle = clip(meta?.title, 200);
                if (epTitle) ep.title = epTitle;
                const air = cleanDate(meta?.airDate);
                if (air) ep.airDate = air;
                return ep;
            });
            const first = dto.episodes[0].airDate || cleanDate(cand.season?.airDate);
            if (first) dto.releaseDate = first; else delete dto.releaseDate;
        }
        return dto;
    }

    /**
     * The title a custom entry shows: the line's title with its qualifier ("Wonder Woman (DCU film)"), which the matcher
     * leaves out when it searches but tells same-named titles apart in the list.
     * @param {Object} entry - Parsed entry.
     * @returns {string}
     */
    function customTitle(entry) {
        const title = clip(entry?.title, 200);
        const qualifier = clip(entry?.qualifier, 100);
        return title && qualifier ? clip(`${title} (${qualifier})`, 200) : title;
    }

    /**
     * Builds a custom entry from the parsed line (no TMDB match). Its media type is the line's (type words, a season or
     * episodes), else the type of the closest match found for it, else movie.
     * @param {Object} entry - Parsed entry.
     * @param {Object} [cand] - The closest candidate, if any.
     * @returns {Object|null} NewPlaceholderDto, or null without a title.
     */
    function customFromEntry(entry, cand) {
        const title = customTitle(entry);
        if (!title) return null;
        const tv = entry.typeHint === 'tv' || Number.isInteger(entry.season) || (entry.episodes || []).length > 0 || !!entry.episodeTitle
            || (entry.typeHint !== 'movie' && cand?.mediaType === 'tv');
        const dto = { kind: 'custom', mediaType: tv ? 'tv' : 'movie', title };
        const date = cleanDate(entry.date);
        if (date) dto.releaseDate = date;
        const year = cleanYear(date ? date.slice(0, 4) : entry.year);
        if (year) dto.year = year;
        const parts = [];
        const season = seasonOf(entry);
        if (entry.episodeTitle) parts.push(entry.episodeTitle);
        else if ((entry.episodes || []).length) parts.push(episodeLabel({ seasonNumber: season, episodes: entry.episodes }));
        else if (Number.isInteger(entry.season)) parts.push(JE.t('jellyseerr_season_name', { number: entry.season }));
        if (entry.note) parts.push(entry.note);
        const note = clip(parts.join(' — '), 300);
        if (note) dto.note = note;
        return dto;
    }

    /**
     * Default decision for a resolved row (spec §7 / p5s report): high and medium → the match ("From your library"
     * when the library has it, or part of a TV scope), TBA lines and lines without a match → custom entry, anything else uncertain
     * (low, alternatives, duplicates, failed lookups) → skip until reviewed.
     * @param {Object} row - Review row.
     * @param {'playlist'|'collection'} listKind
     * @returns {'item'|'placeholder'|'custom'|'skip'}
     */
    function defaultAction(row, listKind) {
        const result = row.result;
        const hasTitle = !!clip(row.entry?.title, 200);
        if (row.dupOf !== undefined) return 'skip';
        if (row.failed || !result || result.state === 'invalid') return 'skip';
        const cand = row.cands[row.cand];
        // No title found: keep catalogue/table/list lines as custom entries (TBA projects), but not fragments of a
        // prose "A → B" chain, which are rarely titles on their own.
        if (!cand) return hasTitle && ((result.reasons || []).includes('tba') || (result.confidence === 'none' && row.entry.source !== 'chain')) ? 'custom' : 'skip';
        if ((result.reasons || []).includes('tba')) return hasTitle ? 'custom' : 'skip';
        if (result.alternatives || result.confidence === 'low' || result.confidence === 'none') return 'skip';
        return fromLibrary(cand, listKind) ? 'item' : 'placeholder';
    }

    /**
     * Whether a row should be looked at before importing.
     * @param {Object} row
     * @returns {boolean}
     */
    function needsReview(row) {
        // Settled by the user: a match confirmed with Change match, or an action picked for the row.
        if (row.confirmed || row.decided) return false;
        if (row.failed || !row.result) return true;
        return row.result.confidence !== 'high' || !!row.result.alternatives || row.dupOf !== undefined || row.sameAs !== undefined;
    }

    /**
     * The best candidate of each alternative of an "A or B" row (for "Add both").
     * @param {Object} row
     * @returns {Array<Object>}
     */
    function alternativePicks(row) {
        const picks = new Map();
        for (const cand of row.cands) {
            const alt = Number.isInteger(cand.alternative) ? cand.alternative : 0;
            if (!picks.has(alt)) picks.set(alt, cand);
        }
        return Array.from(picks.keys()).sort((a, b) => a - b).map(k => picks.get(k));
    }

    /**
     * Whether two placeholders cover the same scope (kind, season, episode numbers).
     * @param {Object|null} a - NewPlaceholderDto.
     * @param {Object|null} b - NewPlaceholderDto.
     * @returns {boolean}
     */
    function sameScope(a, b) {
        if (!a || !b || a.kind !== b.kind || (a.seasonNumber ?? null) !== (b.seasonNumber ?? null)) return false;
        const numbers = ph => (ph.episodes || []).map(e => Number(e.e)).sort((x, y) => x - y).join(',');
        return numbers(a) === numbers(b);
    }

    /**
     * The apply entries a row contributes (0, 1, or 2 with "Add both"), in order.
     * @param {Object} row - Review row.
     * @param {'playlist'|'collection'} listKind
     * @returns {Array<Object>} ApplyEntryDto list.
     */
    function rowEntries(row, listKind) {
        let out = [];
        if (row.action === 'skip') return out;
        if (row.action === 'custom') {
            const dto = customFromEntry(row.entry, row.cands[row.cand]);
            if (dto) out = [{ type: 'placeholder', placeholder: dto }];
        } else {
            const cands = row.both ? alternativePicks(row) : [row.cands[row.cand]].filter(Boolean);
            const overridden = !!(row.override && !row.both);
            out = cands.map((cand) => {
                // The rest of a chosen alternative's scope (not for a scope the user set by hand; Change match always
                // sets one for a show, so one equal to the alternative's first part is no change of scope). That first
                // part is compared as it was when Change match was done: a later library check may narrow the
                // candidate's episodes (it looks at 100 at most).
                const first = placeholderFromCandidate(cand, row.entry, row.result?.kind);
                const more = overridden && !sameScope(row.override, row.overrideFirst || first) ? [] : alternativeMore(cand, row.entry, first)
                    .map(placeholder => ({ type: 'placeholder', placeholder }));
                if (row.action === 'item' && !overridden) {
                    const itemId = libraryItemFor(cand, listKind);
                    if (itemId) {
                        const entry = { type: 'item', itemId };
                        ENTRY_CANDIDATES.set(entry, cand);
                        return [entry, ...more];
                    }
                }
                const dto = overridden ? row.override : placeholderFromCandidate(cand, row.entry, row.result?.kind);
                return dto ? [...splitEpisodes(dto).map(placeholder => ({ type: 'placeholder', placeholder })), ...more] : null;
            }).flat().filter(Boolean);
        }
        if (out.length && row.entry?.sourceKey) {
            out[0].sourceKey = row.entry.sourceKey;
            // A grouped entry (a run of episodes of an exact source) stands for every key of the run.
            if (Array.isArray(row.entry.sourceKeys) && row.entry.sourceKeys.length) out[0].sourceKeys = row.entry.sourceKeys.slice();
        }
        return out;
    }

    /**
     * Splits an episodes placeholder with more episodes than one placeholder holds (PlaceholderRules.MaxEpisodes) into
     * consecutive placeholders of at most that many (each dated by its first episode when TMDB has a date for it); any
     * other placeholder comes back alone.
     * @param {Object} dto - NewPlaceholderDto.
     * @returns {Array<Object>}
     */
    function splitEpisodes(dto) {
        if (dto?.kind !== 'episodes' || !Array.isArray(dto.episodes) || dto.episodes.length <= MAX_EPISODES) return [dto];
        const parts = [];
        for (let i = 0; i < dto.episodes.length; i += MAX_EPISODES) {
            const part = { ...dto, episodes: dto.episodes.slice(i, i + MAX_EPISODES) };
            const first = part.episodes[0].airDate;
            if (i > 0 && first) part.releaseDate = first;
            parts.push(part);
        }
        return parts;
    }

    /**
     * The placeholders for the rest of a chosen alternative's scope: an alternative whose text named more than one
     * season or more than MAX_EPISODES episodes ("Doctor Who S1E5–S2E3 **or** Torchwood") keeps the later parts as
     * `more`; they go in right after its first part, for the same title (TMDB fills in their dates later).
     * @param {Object} cand - The chosen candidate (its `alternative` index).
     * @param {Object} entry - Parsed entry.
     * @param {Object|null} dto - The placeholder of the alternative's first part.
     * @returns {Array<Object>} NewPlaceholderDto list (empty when there is nothing more).
     */
    function alternativeMore(cand, entry, dto) {
        const alt = Array.isArray(entry?.alternatives) ? entry.alternatives[Number.isInteger(cand?.alternative) ? cand.alternative : 0] : undefined;
        if (!dto || cand?.mediaType !== 'tv' || !Array.isArray(alt?.more) || !alt.more.length) return [];
        const base = { mediaType: 'tv', tmdbId: dto.tmdbId, title: dto.title };
        for (const key of ['posterPath', 'overview', 'imdbId', 'tvdbId', 'note']) if (dto[key] !== undefined) base[key] = dto[key];
        const out = [];
        for (const scope of alt.more) {
            const season = Number(scope?.season);
            if (!Number.isInteger(season) || season < 0 || season > 200) continue;
            const episodes = (scope.episodes || []).filter(e => Number(e.s) === season).map(e => Number(e.e)).filter(n => Number.isInteger(n) && n >= 0 && n <= 9999);
            if (episodes.length) {
                out.push(...splitEpisodes({ ...base, kind: 'episodes', seasonNumber: season, episodes: episodes.map(e => ({ s: season, e })) }));
            } else if (!scope.episodes?.length) {
                out.push({ ...base, kind: 'season', seasonNumber: season });
            }
        }
        return out;
    }

    /**
     * Every apply entry of the review, in list order.
     * @param {Array<Object>} rows
     * @param {'playlist'|'collection'} listKind
     * @param {Array<Object>} [owners] - Filled with the row of each entry (same index), for the result report.
     * @returns {Array<Object>}
     */
    function buildEntries(rows, listKind, owners) {
        const entries = [];
        for (const row of rows) {
            for (const entry of rowEntries(row, listKind)) {
                entries.push(entry);
                owners?.push(row);
            }
        }
        return entries;
    }

    /**
     * A title's identity the way the server tells duplicates apart (PlaceholderRules.IdentityKey / NormalizeTitle).
     * @param {Object} ph - NewPlaceholderDto.
     * @returns {string}
     */
    function placeholderKey(ph) {
        if (ph.kind === 'custom') {
            const title = String(ph.title || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
            return ['custom', ph.mediaType, title, ph.year ?? ''].join('|');
        }
        const episodes = (ph.episodes || []).map(e => Number(e.e)).sort((a, b) => a - b).join(',');
        return [ph.kind, ph.mediaType, ph.tmdbId ?? '', ph.seasonNumber ?? '', episodes].join('|');
    }

    /**
     * The identities an apply entry stands for: its placeholder, or its library item plus the title it is.
     * @param {Object} entry - ApplyEntryDto.
     * @param {Object} row - Its review row.
     * @returns {string[]}
     */
    function entryKeys(entry, row) {
        if (entry.placeholder) return [placeholderKey(entry.placeholder)];
        const keys = [`item|${entry.itemId}`];
        // The title this item is: its own candidate (each alternative of "Add both" is a different title).
        const cand = ENTRY_CANDIDATES.get(entry) || row.cands[row.cand];
        const dto = cand ? placeholderFromCandidate(cand, row.entry, row.result?.kind) : null;
        if (dto) keys.push(placeholderKey(dto));
        return keys;
    }

    /**
     * The identities a row resolves to, whether or not it is skipped: what it imports, or (skipped) what its match
     * would import.
     * @param {Object} row
     * @param {'playlist'|'collection'} listKind
     * @returns {string[]}
     */
    function rowKeys(row, listKind) {
        if (row.action !== 'skip') return rowEntries(row, listKind).flatMap(entry => entryKeys(entry, row));
        const cand = row.cands[row.cand];
        const dto = cand ? placeholderFromCandidate(cand, row.entry, row.result?.kind) : null;
        return dto ? [placeholderKey(dto)] : [];
    }

    /**
     * Flags rows that resolve to the same title as an earlier row that is imported ("Same title as row N"): the server
     * would drop them as duplicates. Sets row.sameAs (row index) or clears it.
     * @param {Array<Object>} rows
     * @param {'playlist'|'collection'} listKind
     * @returns {Array<Object>} The rows whose flag changed.
     */
    function markSameTitles(rows, listKind) {
        const first = new Map();
        const changed = [];
        for (const row of rows) {
            const keys = row.result ? rowKeys(row, listKind) : [];
            // A line the parser already flagged as a repeat says so itself ("Same as line N").
            const hit = row.dupOf === undefined ? keys.map(k => first.get(k)).find(i => i !== undefined) : undefined;
            if (hit !== row.sameAs) changed.push(row);
            if (hit === undefined) delete row.sameAs; else row.sameAs = hit;
            if (row.action !== 'skip') keys.forEach((k) => { if (!first.has(k)) first.set(k, row.i); });
        }
        return changed;
    }

    /**
     * Counts for the review summary. "entries" is what the import really adds: entries that repeat an earlier entry's
     * title are left out (the server skips them).
     * @param {Array<Object>} rows
     * @param {'playlist'|'collection'} listKind
     * @returns {{total: number, matched: number, library: number, review: number, failed: number, entries: number}}
     */
    function summarize(rows, listKind) {
        const counts = { total: rows.length, matched: 0, library: 0, review: 0, failed: 0, entries: 0 };
        const seen = new Set();
        for (const row of rows) {
            if (row.failed) counts.failed++;
            if (needsReview(row)) counts.review++;
            if (row.action === 'item') counts.library++;
            if (row.action === 'item' || row.action === 'placeholder') counts.matched++;
            for (const entry of rowEntries(row, listKind)) {
                const keys = entryKeys(entry, row);
                if (keys.some(k => seen.has(k))) continue;
                keys.forEach(k => seen.add(k));
                counts.entries++;
            }
        }
        return counts;
    }

    /**
     * Sections of a parse that have entries ("before the first heading" included), in order.
     * @param {Array<Object>} entries - Parsed entries.
     * @returns {Array<{key: string, title: string, count: number}>}
     */
    function sectionsOf(entries) {
        const map = new Map();
        for (const entry of entries) {
            const key = entry.section || NO_SECTION;
            const known = map.get(key);
            if (known) known.count++;
            else map.set(key, { key, title: entry.section || '', count: 1 });
        }
        return Array.from(map.values());
    }

    /**
     * Milliseconds to wait before retrying a 429/504 answer.
     * @param {*} error
     * @returns {number}
     */
    function retryDelay(error) {
        const seconds = Number(error?.responseJSON?.retryAfter ?? error?.retryAfter);
        return Number.isFinite(seconds) && seconds > 0 ? Math.min(30, seconds) * 1000 : RETRY_DELAY_MS;
    }

    /**
     * A playlist name from a list URL's last path segment ("top-watched-movies-of-the-week" → "Top watched movies
     * of the week"); numeric or missing segments give "<Site> list".
     * @param {string} url
     * @param {string} site - Display name of the list site.
     * @returns {string}
     */
    function nameFromUrl(url, site) {
        let segment = '';
        try {
            segment = decodeURIComponent(new URL(String(url)).pathname.split('/').filter(Boolean).pop() || '');
        } catch (_) {
            segment = '';
        }
        const words = segment.replace(/^\d+-(?=\D)/, '').replace(/[-_+]+/g, ' ').trim();
        if (!words || /^\d+$/.test(words) || /^(json|watchlist|lists?)$/i.test(words)) return site ? JE.t('arr_list_import_site_list', { site }) : '';
        return words.charAt(0).toUpperCase() + words.slice(1);
    }

    /**
     * Abortable sleep.
     * @param {number} ms
     * @param {AbortSignal} [signal]
     * @returns {Promise<void>}
     */
    function sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) { reject(abortError()); return; }
            const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
            /** Stops the wait. */
            function onAbort() { clearTimeout(timer); reject(abortError()); }
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    /** @returns {Error} An AbortError. */
    function abortError() {
        const error = new Error('aborted');
        error.name = 'AbortError';
        return error;
    }

    /**
     * Message for a failed URL read (or a source error on apply).
     * @param {*} error
     * @returns {string} Plain text.
     */
    function sourceErrorText(error) {
        const code = error?.responseJSON?.code;
        if (sourceErrorKey(code)) return JE.t(sourceErrorKey(code));
        if (error?.responseJSON?.message && error.status >= 400 && error.status < 500) return String(error.responseJSON.message);
        return JE.t('arr_list_import_err_upstream');
    }

    /**
     * The en.json key for a source error code (fetch, link or sync), or null when the code has none.
     * @param {string} code
     * @returns {string|null}
     */
    function sourceErrorKey(code) {
        return (typeof code === 'string' && Object.prototype.hasOwnProperty.call(SOURCE_ERROR_KEYS, code)) ? SOURCE_ERROR_KEYS[code] : null;
    }

    /**
     * Whether a failed import may still have been applied: the plugin didn't answer (network error, proxy timeout or
     * gateway error without its JSON error body). A plugin error answer means nothing was recorded for the request id.
     * @param {*} error - Error from JE.core.api (status/responseJSON).
     * @returns {boolean}
     */
    function isUnconfirmedFailure(error) {
        if (error?.responseJSON?.code) return false;
        const status = Number(error?.status) || 0;
        return status === 0 || status === 408 || status >= 500;
    }

    /**
     * Source keys sent as a URL import's snapshot: only rows that were looked up (the reviewer could decide on them).
     * The server declines snapshot keys that weren't imported, so a row whose lookup failed must stay out of it. A
     * grouped entry contributes every key of its run; when every fetched entry of a grouped fetch has a decided row,
     * the fetch's own snapshotKeys are sent as they are.
     * @param {Object[]} rows - Review rows.
     * @param {Object} [fetched] - SourceFetchResponse of the import.
     * @returns {string[]}
     */
    function snapshotKeys(rows, fetched) {
        const list = rows || [];
        const decided = list.filter(r => r.result && !r.failed);
        if (fetched?.grouped && Array.isArray(fetched.snapshotKeys) && decided.length === list.length
            && list.length === (fetched.entries || []).length) {
            return fetched.snapshotKeys.filter(k => typeof k === 'string' && k).slice(0, MAX_SNAPSHOT_KEYS);
        }
        const keys = decided.flatMap(r => (Array.isArray(r.entry?.sourceKeys) && r.entry.sourceKeys.length ? r.entry.sourceKeys : [r.entry?.sourceKey]));
        return Array.from(new Set(keys.filter(k => typeof k === 'string' && k))).slice(0, MAX_SNAPSHOT_KEYS);
    }

    /**
     * Message for a resolve failure that stops the lookup.
     * @param {*} error
     * @returns {string|null} Plain text, or null when the chunk should just be retried / marked failed.
     */
    function fatalResolveText(error) {
        const code = error?.responseJSON?.code;
        // No title lookup on this server (no TMDB key, no Seerr): JE imports need no linked Seerr account.
        if (error?.status === 503 || code === 'metadata_unavailable') return JE.t('arr_list_import_err_metadata');
        if (code === 'disabled') return JE.t('arr_list_import_err_disabled');
        if (error?.status === 403) return JE.t('arr_list_import_err_forbidden');
        if (error?.status === 404) return JE.t('arr_list_import_err_not_found');
        if (error?.status === 400) return JE.t('arr_list_import_err_generic');
        return null;
    }

    /**
     * A pasted line without markdown link targets, emphasis and table pipes, for display.
     * @param {string} raw
     * @returns {string}
     */
    function plainLine(raw) {
        let text = String(raw || '').trim();
        if (text.startsWith('|')) text = text.split('|').map(cell => cell.trim()).filter(Boolean).join(' · ');
        return text
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/(\*\*|__|`)/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Label of a candidate: "Title (2017) · Movie".
     * @param {Object} cand
     * @returns {string} Plain text.
     */
    function candidateLabel(cand) {
        const year = cleanYear(cand.year) || (cleanDate(cand.releaseDate) || '').slice(0, 4);
        const type = cand.mediaType === 'tv' ? JE.t('arr_list_import_kind_series') : JE.t('arr_list_import_kind_movie');
        return `${cand.title || ''}${year ? ` (${year})` : ''} · ${type}`;
    }

    /**
     * What the row will import, for its label.
     * @param {Object} row
     * @param {'playlist'|'collection'} listKind
     * @returns {Object|null} A placeholder-like object (kind, title, dates) or null.
     */
    function previewOf(row, listKind) {
        if (row.action === 'custom') return customFromEntry(row.entry, row.cands[row.cand]);
        const cand = row.cands[row.cand];
        if (!cand) return null;
        if (row.override) return row.override;
        return placeholderFromCandidate(cand, row.entry, row.result?.kind) || { kind: cand.mediaType === 'movie' ? 'movie' : 'series', title: cand.title };
    }

    // ── Transport ───────────────────────────────────────────────────────

    /**
     * Whether import (paste, file, URL review) is on for this server.
     * @returns {boolean}
     */
    function enabled() {
        return JE.pluginConfig?.ArrListImportEnabled === true;
    }

    /**
     * Whether From URL is on (each provider still has its own switch: see providers()).
     * @returns {boolean}
     */
    function sourcesEnabled() {
        return JE.pluginConfig?.ArrListSourcesEnabled === true;
    }

    /**
     * The current session epoch (a user switch changes it).
     * @returns {number}
     */
    function epoch() {
        return JE.session?.getEpoch ? JE.session.getEpoch() : 0;
    }

    /**
     * Calls an import route. Resolves with the body of a 2xx answer; rejects with {status, responseJSON, retryAfter} for
     * any other answer, with {stale: true} when the user changed meanwhile, and with the fetch error (AbortError
     * included) when no answer arrived.
     * @param {string} path - Path under /JellyfinEnhanced/acquire/lists/import.
     * @param {{method?: string, body?: Object, signal?: AbortSignal}} [options]
     * @returns {Promise<Object|null>}
     */
    async function call(path, options) {
        const started = epoch();
        const method = options?.method || 'GET';
        const headers = { 'Authorization': `MediaBrowser Token="${ApiClient.accessToken()}"`, 'Accept': 'application/json' };
        if (options?.body) headers['Content-Type'] = 'application/json';
        const response = await fetch(ApiClient.getUrl(`/JellyfinEnhanced/acquire/lists/import${path}`), {
            method,
            headers,
            body: options?.body ? JSON.stringify(options.body) : undefined,
            signal: options?.signal,
            cache: 'no-store'
        });
        if (epoch() !== started) {
            throw { stale: true };
        }

        let body = null;
        try {
            const text = await response.text();
            body = text ? JSON.parse(text) : null;
        } catch {
            body = null;
        }

        if (response.status >= 200 && response.status < 300) return body;
        const retryAfter = Number(response.headers?.get?.('Retry-After'));
        throw { status: response.status, responseJSON: body, retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined };
    }

    const api = {
        /**
         * Resolves up to 25 import entries (toImportEntry) to candidates.
         * @param {Object[]} entries - ImportEntryDto list.
         * @param {{listId?: string, signal?: AbortSignal}} [options] - Target list (its owner's library view counts too).
         * @returns {Promise<Object>} ResolveResponse ({results[], complete, upstreamCalls, metadataProvider}).
         */
        resolve: (entries, options) => call('/resolve', { method: 'POST', body: { entries, ...(options?.listId ? { listId: options.listId } : {}) }, signal: options?.signal }),
        /**
         * Reads a list URL into entries with ids.
         * @param {string} url - List URL.
         * @param {{listId?: string, useMdblistApi?: boolean, signal?: AbortSignal}} [options] - useMdblistApi: an administrator's deliberate MDBList API read.
         * @returns {Promise<Object>} SourceFetchResponse ({kind, provider, url, title, unofficial, notice?, entries[], total, truncated, dropped, partial?, grouped, snapshotKeys?, snapshot?, countsHidden?}).
         */
        fetchSource: (url, options) => call('/source', {
            method: 'POST',
            body: { url, ...(options?.listId ? { listId: options.listId } : {}), ...(options?.useMdblistApi ? { useMdblistApi: true } : {}) },
            signal: options?.signal
        }),
        /**
         * Which sources work on this server (no secrets).
         * @param {{signal?: AbortSignal}} [options]
         * @returns {Promise<Object>} SourceProvidersDto.
         */
        providers: options => call('/providers', { signal: options?.signal })
    };

    /**
     * Reads a list URL, retrying while the caller's parental checks are still running.
     * @param {string} url
     * @param {{listId?: string, useMdblistApi?: boolean, signal?: AbortSignal}} [options]
     * @returns {Promise<Object>} SourceFetchResponse.
     */
    async function fetchWithRetry(url, options) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await api.fetchSource(url, options);
            } catch (error) {
                if (error?.responseJSON?.code === 'parental_pending' && attempt < MAX_CHUNK_RETRIES) {
                    await sleep(retryDelay(error), options?.signal);
                    continue;
                }
                throw error;
            }
        }
    }

    /**
     * A review row for a parsed or fetched entry (index `i` is the entry's place; prepared entries are resolved).
     * @param {Object} entry - ParsedEntry or ImportEntryDto.
     * @param {number} i - Row index.
     * @param {'playlist'|'collection'} listKind
     * @returns {Object} Row ({i, entry, result, cands, cand, action, failed, transient}).
     */
    function newRow(entry, i, listKind) {
        const row = { i, entry, result: null, cands: [], cand: -1, action: 'skip', failed: false, transient: false };
        if (entry?.prepared) applyResult(row, { ...entry.prepared, index: i }, listKind);
        if (entry?.dupOf !== undefined) row.dupOf = entry.dupOf;
        return row;
    }

    /**
     * Stores a resolution on its row and picks the default decision (a transient result marks the row for a retry).
     * @param {Object} row
     * @param {Object|null} result - ResolvedEntryDto.
     * @param {'playlist'|'collection'} listKind
     */
    function applyResult(row, result, listKind) {
        if (!result || result.state === 'transient') {
            row.transient = true;
            return;
        }

        row.transient = false;
        row.failed = false;
        row.result = result;
        row.cands = candidateList(result);
        // No match (confidence none): the candidates stay pickable, but the row shows the line.
        row.cand = result.match ? Math.max(0, row.cands.findIndex(c => sameCandidate(c, result.match))) : -1;
        row.decided = false;
        delete row.sameAs;
        row.action = defaultAction(row, listKind);
    }

    /**
     * Resolves one chunk of rows: retries busy and parental-pending answers, one more try after a network failure, stops
     * on errors that can't heal (their text on `error.jeImportFatal`). Rows left without an answer are transient.
     * @param {Object[]} chunk
     * @param {{listId?: string, listKind: 'playlist'|'collection', signal?: AbortSignal}} options
     * @returns {Promise<void>}
     */
    async function resolveChunk(chunk, options) {
        const entries = chunk.map(row => toImportEntry(row.entry, row.i));
        let networkRetries = 0;
        for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
            let response;
            try {
                response = await api.resolve(entries, { listId: options.listId, signal: options.signal });
            } catch (error) {
                if (error?.name === 'AbortError' || options.signal?.aborted) throw abortError();
                if (error?.stale) throw error;
                const code = error?.responseJSON?.code;
                if (error?.status === 429 || (error?.status === 504 && code === 'parental_pending')) {
                    await sleep(retryDelay(error), options.signal);
                    continue;
                }
                const fatal = fatalResolveText(error);
                if (fatal) {
                    const stop = new Error(fatal);
                    stop.jeImportFatal = fatal;
                    throw stop;
                }
                if (networkRetries++ < 1) {
                    await sleep(RETRY_DELAY_MS, options.signal);
                    continue;
                }
                break;
            }
            const byIndex = new Map((response?.results || []).map(r => [r.index, r]));
            chunk.forEach(row => applyResult(row, byIndex.get(row.i), options.listKind));
            return;
        }
        chunk.forEach((row) => { row.transient = true; });
    }

    /**
     * Resolves every row in sequential chunks of 25, then resubmits transient rows once; rows that still have no answer
     * fail (skipped). Prepared rows (exact sources) are never sent. A fatal error leaves the rows resolved so far and
     * fails the rest, then rejects with it.
     * @param {Object[]} rows - Review rows (newRow).
     * @param {{listId?: string, listKind?: 'playlist'|'collection', signal?: AbortSignal, onChunk?: function(Object[], number): void}} [options]
     * @returns {Promise<Object[]>} The rows.
     */
    async function resolveRows(rows, options = {}) {
        const opts = { listKind: 'playlist', ...options };
        let done = 0;
        try {
            for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
                const chunk = rows.slice(start, start + CHUNK_SIZE);
                const pending = chunk.filter(r => !r.result);
                if (pending.length) await resolveChunk(pending, opts);
                done += chunk.length;
                opts.onChunk?.(chunk, done);
            }
            const transient = rows.filter(r => r.transient);
            for (let start = 0; start < transient.length; start += CHUNK_SIZE) {
                const chunk = transient.slice(start, start + CHUNK_SIZE);
                await resolveChunk(chunk, opts);
                chunk.forEach(row => { if (row.transient) { row.transient = false; row.failed = true; row.action = 'skip'; } });
                opts.onChunk?.(chunk, done);
            }
        } catch (error) {
            if (error?.name !== 'AbortError' && !error?.stale) {
                rows.filter(r => !r.result).forEach((row) => { row.failed = true; row.transient = false; row.action = 'skip'; });
                console.warn(logPrefix, 'lookup stopped', error?.jeImportFatal || error?.status || error);
            }
            throw error;
        }
        markSameTitles(rows, opts.listKind);
        return rows;
    }

    JE.arrListImport = JE.arrListImport || {};
    Object.assign(JE.arrListImport, {
        enabled,
        sourcesEnabled,
        api,
        fetchWithRetry,
        resolveRows,
        newRow,
        applyResult,
        CHUNK_SIZE,
        review: Object.freeze({
            toImportEntry,
            candidateList,
            sameCandidate,
            libraryItemFor,
            fromLibrary,
            libraryChipText,
            kindFor,
            placeholderFromCandidate,
            customFromEntry,
            defaultAction,
            needsReview,
            alternativePicks,
            rowEntries,
            splitEpisodes,
            buildEntries,
            markSameTitles,
            summarize,
            sectionsOf,
            snapshotKeys,
            reasonKey,
            noticeText,
            sourceErrorKey,
            sourceErrorText,
            fatalResolveText,
            isUnconfirmedFailure,
            nameFromUrl,
            plainLine,
            candidateLabel,
            previewOf,
            episodeLabel,
            tn
        })
    });
})(window.JellyfinEnhanced);
