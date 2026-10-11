// /js/jellyseerr/listplaceholders/listplaceholders-import.js
// "Import list" (B9/B10, spec §7/§8): Paste | From URL → parse (listplaceholders-parser.js) or
// POST /source/fetch → POST /resolve in sequential chunks of 25 with progress (busy/parental
// retries, one resubmit of transient entries) → review (one row per entry: match, candidates,
// kind, In library / Placeholder / Custom entry / Skip, alternatives, "Accept all high
// confidence", sections) → POST /{listId}/apply or POST /playlists (new playlist), in order,
// with the "Keep in sync" link for URL imports. One requestId per review so a retried apply
// is replayed by the server instead of applied twice.
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.listPlaceholders = JE.internals.listPlaceholders || {};

    const CHUNK_SIZE = 25;
    const MAX_APPLY = 2000;
    /** Most episodes one placeholder holds (PlaceholderRules.MaxEpisodes). */
    const MAX_EPISODES = 100;
    /** Most episodes an open-ended range expands to (the server's MaxOpenEndedEpisodes). */
    const MAX_EXPANDED_EPISODES = 1000;
    const MAX_SNAPSHOT_KEYS = 5000;
    const MAX_CHUNK_RETRIES = 5;
    const RETRY_DELAY_MS = 2000;
    const PARSE_DEBOUNCE_MS = 400;
    const SEARCH_DEBOUNCE_MS = 350;
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const IMDB_RE = /^tt\d{5,10}$/;
    const NO_SECTION = '';
    /** The candidate each library-item apply entry came from (its title identity; never serialised). */
    const ENTRY_CANDIDATES = new WeakMap();

    /** Review reasons the server sends → en.json keys (unknown reasons show nothing). */
    const REASON_KEYS = {
        tba: 'listPlaceholders_import_reason_tba',
        alternatives: 'listPlaceholders_import_reason_alternatives',
        noYear: 'listPlaceholders_import_reason_no_year',
        tie: 'listPlaceholders_import_reason_tie',
        lowScore: 'listPlaceholders_import_reason_weak',
        closeMatch: 'listPlaceholders_import_reason_close',
        noMatch: 'listPlaceholders_import_reason_no_match',
        notFound: 'listPlaceholders_import_reason_no_match',
        seasonMissing: 'listPlaceholders_import_reason_season_missing',
        episodeMissing: 'listPlaceholders_import_reason_episode_missing',
        episodeByTitle: 'listPlaceholders_import_reason_episode_title',
        episodeIdUnsupported: 'listPlaceholders_import_reason_episode_id',
        typeMismatch: 'listPlaceholders_import_reason_type',
        openEnded: 'listPlaceholders_import_reason_open_ended',
        openEndedTruncated: 'listPlaceholders_import_reason_open_ended_truncated',
        yearOff: 'listPlaceholders_import_reason_year_off',
        otherYear: 'listPlaceholders_import_reason_other_year',
        unreleased: 'listPlaceholders_import_reason_unreleased',
        invalid: 'listPlaceholders_import_reason_invalid'
    };

    /** /source/fetch error codes → en.json keys. */
    const SOURCE_ERROR_KEYS = {
        letterboxd_unsupported: 'listPlaceholders_sourceLetterboxd',
        unsupported_url: 'listPlaceholders_sourceUnsupported',
        invalid_url: 'listPlaceholders_sourceUnsupported',
        trakt_not_configured: 'listPlaceholders_import_err_trakt',
        trakt_unauthorized: 'listPlaceholders_import_err_trakt',
        tmdb_key_required: 'listPlaceholders_import_err_tmdb_key',
        tmdb_key_invalid: 'listPlaceholders_import_err_tmdb_key',
        imdb_disabled: 'listPlaceholders_import_err_imdb',
        not_found: 'listPlaceholders_import_err_list_not_found',
        rate_limited: 'listPlaceholders_import_err_rate_limited',
        quota_exhausted: 'listPlaceholders_import_err_rate_limited',
        fetch_limited: 'listPlaceholders_import_err_fetch_limited',
        upstream_error: 'listPlaceholders_import_err_upstream',
        unreachable: 'listPlaceholders_import_err_upstream',
        too_large: 'listPlaceholders_import_err_upstream',
        timeout: 'listPlaceholders_import_err_upstream',
        source_format_changed: 'listPlaceholders_sourceFormatChanged'
    };

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
        const id = lp.normalizeId(lib?.itemId);
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
        return cand?.mediaType === 'tv' && !!lp.normalizeId(lib?.itemId) && Array.isArray(lib.episodeItemIds) && lib.episodeItemIds.length > 0;
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
        if (cand.mediaType !== 'tv' || lib.complete || !count) return JE.t('listPlaceholders_in_library');
        const total = lib.kind === 'episodes' ? (cand.episodes || []).length : Number(lib.kind === 'season' ? cand.season?.episodeCount : cand.episodeTotal);
        return Number.isInteger(total) && total > count
            ? lp.tn('listPlaceholders_import_in_library_part', { count, total }, 'total')
            : lp.tn('listPlaceholders_import_in_library_episodes', { count });
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
        if (lp.render.isSafePoster(cand.posterPath)) dto.posterPath = cand.posterPath;
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
        else if ((entry.episodes || []).length) parts.push(lp.render.episodeLabel({ seasonNumber: season, episodes: entry.episodes }));
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
                // The rest of a chosen alternative's scope (not for a scope the user set by hand).
                const more = overridden ? [] : alternativeMore(cand, row.entry, placeholderFromCandidate(cand, row.entry, row.result?.kind))
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
        if (!words || /^\d+$/.test(words) || /^(json|watchlist|lists?)$/i.test(words)) return site ? JE.t('listPlaceholders_import_site_list', { site }) : '';
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
     * Message for a failed /source/fetch (or a source error on apply).
     * @param {*} error
     * @returns {string} Plain text.
     */
    function sourceErrorText(error) {
        const code = error?.responseJSON?.code;
        if (sourceErrorKey(code)) return JE.t(sourceErrorKey(code));
        if (error?.responseJSON?.message && error.status >= 400 && error.status < 500) return String(error.responseJSON.message);
        return JE.t('listPlaceholders_import_err_upstream');
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
     * Message for a /resolve failure that stops the lookup.
     * @param {*} error
     * @returns {string|null} Plain text, or null when the chunk should just be retried / marked failed.
     */
    function fatalResolveText(error) {
        const code = error?.responseJSON?.code;
        if (error?.status === 503 || code === 'seerr_unavailable') return JE.t('listPlaceholders_import_err_seerr');
        if (code === 'seerr_unlinked') return JE.t('listPlaceholders_import_err_unlinked');
        if (error?.status === 403) return JE.t('listPlaceholders_err_forbidden');
        if (error?.status === 404) return JE.t('listPlaceholders_err_not_found');
        if (error?.status === 400) return JE.t('listPlaceholders_err_generic');
        return null;
    }

    // ── Markup ──────────────────────────────────────────────────────────

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
        const type = cand.mediaType === 'tv' ? JE.t('listPlaceholders_kind_series') : JE.t('listPlaceholders_kind_movie');
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

    /**
     * Markup of one review row (all text escaped).
     * @param {Object} row
     * @param {{listKind: string}} ctx
     * @returns {string}
     */
    function rowHtml(row, ctx) {
        const esc = lp.render.esc;
        const cand = row.cands[row.cand] || null;
        const pending = !row.result && !row.failed;
        const custom = row.action === 'custom';
        // The match is only the row's title when it is what gets imported; otherwise (skipped, custom) the line's
        // title is, and the match is offered as the closest one found.
        const chosen = !!cand && (row.action === 'placeholder' || row.action === 'item');
        const preview = chosen || custom ? previewOf(row, ctx.listKind) : null;
        const title = chosen ? (cand.title || '') : (customTitle(row.entry) || row.entry.raw || '');
        const poster = chosen && lp.render.isSafePoster(cand.posterPath) ? lp.render.posterUrl(cand.posterPath, 'w92') : '';
        const meta = [];
        if (preview) meta.push(esc(lp.render.kindLabel(preview)));
        // A season or episodes row shows when that part aired, not when the show started.
        const scopedYear = (cleanDate(preview?.releaseDate) || '').slice(0, 4);
        const scoped = preview?.kind === 'season' || preview?.kind === 'episodes';
        const year = custom ? cleanYear(row.entry.year)
            : !chosen ? ''
                : scoped ? scopedYear // an undated season (announced) has no year: never the show's
                    : (cleanYear(preview?.year) || cleanYear(cand.year) || (cleanDate(preview?.releaseDate) || '').slice(0, 4));
        if (year) meta.push(esc(String(year)));
        if (row.both && chosen) meta.push(esc(JE.t('listPlaceholders_import_both_short')));
        let chips = '';
        if (pending) {
            chips += `<span class="je-lp-chip">${esc(JE.t('listPlaceholders_import_looking_up_short'))}</span>`;
        } else if (row.failed) {
            chips += `<span class="je-lp-chip je-lp-conf-none">${esc(JE.t('listPlaceholders_import_failed_row'))}</span>`;
        } else if (row.confirmed) {
            chips += `<span class="je-lp-chip je-lp-conf-high">${esc(JE.t('listPlaceholders_import_confirmed'))}</span>`;
        } else if (!custom) {
            // A custom entry doesn't use the match: its confidence and hints would describe something not imported.
            const conf = ['high', 'medium', 'low', 'none'].includes(row.result.confidence) ? row.result.confidence : 'none';
            chips += `<span class="je-lp-chip je-lp-conf-${conf}">${esc(JE.t(`listPlaceholders_import_conf_${conf}`))}</span>`;
        }
        const libraryText = chosen ? libraryChipText(cand, ctx.listKind) : '';
        if (libraryText) chips += ` <span class="je-lp-chip je-lp-chip-lib">${esc(libraryText)}</span>`;
        if (row.libraryPending) chips += ` <span class="je-lp-chip">${esc(JE.t('listPlaceholders_import_checking_library'))}</span>`;
        const reasons = row.confirmed || custom ? [] : (row.result?.reasons || []).map(r => REASON_KEYS[r]).filter(Boolean);
        const hints = Array.from(new Set(reasons)).map(key => JE.t(key));
        if (cand && !chosen && !custom && !pending) hints.unshift(JE.t('listPlaceholders_import_closest', { title: candidateLabel(cand) }));
        if (row.sameAs !== undefined) hints.unshift(JE.t('listPlaceholders_import_same_title', { row: row.sameAs + 1 }));
        if (row.dupOf !== undefined) hints.unshift(JE.t('listPlaceholders_import_dup', { line: row.dupOfLine ?? row.dupOf + 1 }));
        const lineText = plainLine(row.entry.raw || row.entry.title || '');
        const source = row.entry.line ? JE.t('listPlaceholders_import_line', { line: row.entry.line, text: lineText }) : lineText;

        const options = [];
        const canItem = !!cand && (row.both ? alternativePicks(row).some(c => fromLibrary(c, ctx.listKind)) : fromLibrary(cand, ctx.listKind));
        if (canItem) options.push(['item', JE.t('listPlaceholders_import_action_item')]);
        if (cand) options.push(['placeholder', JE.t('listPlaceholders_import_action_placeholder')]);
        if (clip(row.entry.title, 200)) options.push(['custom', JE.t('listPlaceholders_import_action_custom')]);
        options.push(['skip', JE.t('listPlaceholders_import_action_skip')]);
        const label = JE.t('listPlaceholders_import_action_label', { line: row.i + 1 });
        const select = pending ? '' : `<select class="je-lp-select je-lp-irow-action" aria-label="${esc(label)}">${options.map(([value, text]) => `<option value="${value}"${value === row.action ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select>`;
        const canEdit = !pending && (row.cands.length > 0 || JE.jellyseerrAPI?.search);
        const edit = canEdit ? `<button type="button" class="je-lp-irow-edit" aria-label="${esc(JE.t('listPlaceholders_import_change'))}" title="${esc(JE.t('listPlaceholders_import_change'))}" aria-expanded="false"><span class="material-icons" aria-hidden="true">edit</span></button>` : '';
        const classes = ['je-lp-irow'];
        if (needsReview(row)) classes.push('je-lp-irow-review');
        if (row.action === 'skip') classes.push('je-lp-irow-skip');
        return `<div class="${classes.join(' ')}" role="listitem" data-i="${row.i}">`
            + `<span class="je-lp-irow-num" aria-hidden="true">${row.i + 1}</span>`
            + `<span class="je-lp-irow-poster">${poster ? `<img loading="lazy" decoding="async" alt="" src="${esc(poster)}">` : '<span class="material-icons" aria-hidden="true">movie</span>'}</span>`
            + '<span class="je-lp-irow-main">'
            + `<span class="je-lp-irow-title">${esc(title)}</span>`
            + `<span class="je-lp-irow-meta">${meta.join(' · ')}${meta.length ? ' ' : ''}${chips}</span>`
            + (hints.length ? `<span class="je-lp-irow-hint">${esc(hints.join(' · '))}</span>` : '')
            + (source && source !== title ? `<span class="je-lp-irow-line" title="${esc(source)}">${esc(source)}</span>` : '')
            + '</span>'
            + `<span class="je-lp-irow-controls">${select}${edit}</span>`
            + '</div>';
    }

    // ── The modal ───────────────────────────────────────────────────────

    /**
     * Opens the import modal.
     * @param {Object} options
     * @param {Object} [options.ctrl] - Page controller of the list to import into ({listId, listKind, listName, view, afterRealItemsAdded?}).
     * @param {'existing'|'new'} [options.mode] - 'new' creates a playlist (default when no ctrl is given).
     * @param {string} [options.name] - Suggested name of the new playlist.
     * @returns {Object|null} The modal instance.
     */
    function open(options = {}) {
        if (!lp.isEnabled() || !JE.jellyseerrModal?.create) return null;
        const parser = lp.parser || JE.listPlaceholders?.parser;
        if (!parser?.parse) return null;
        lp.ensureStyles?.();
        const esc = lp.render.esc;
        const ctrl = options.mode === 'new' ? null : options.ctrl || null;
        const isNew = !ctrl;
        const listKind = ctrl ? ctrl.listKind : 'playlist';
        const listId = ctrl ? ctrl.listId : null;

        const state = {
            step: 'input', // input → resolving → review → applying (→ retry: an unconfirmed failure, resend unchanged)
            frozen: null, // the request of an unconfirmed failed import, resent as is
            tab: 'paste',
            parse: null,
            parsedText: null,
            parseTimer: null,
            fetched: null, // SourceFetchResponse of a URL import
            rows: [],
            controller: null,
            requestId: lp.newRequestId(),
            providers: null,
            closed: false,
            editor: null,
            owners: [], // the review row of each entry of the last import request
            epoch: lp.epochNow()
        };

        const body = `
            <div class="je-lp-add je-lp-import">
                <div class="je-lp-import-input">
                    <div class="je-lp-tabs" role="tablist">
                        <button type="button" class="je-lp-tab je-lp-tab-active" role="tab" aria-selected="true" data-tab="paste">${esc(JE.t('listPlaceholders_import_tab_paste'))}</button>
                        <button type="button" class="je-lp-tab" role="tab" aria-selected="false" data-tab="url">${esc(JE.t('listPlaceholders_import_tab_url'))}</button>
                    </div>
                    <div class="je-lp-pane" data-pane="paste">
                        <label class="je-lp-field"><span>${esc(JE.t('listPlaceholders_import_paste_label'))}</span>
                            <textarea class="je-lp-input je-lp-import-text" rows="10" spellcheck="false" autocomplete="off"></textarea></label>
                        <div class="je-lp-muted">${esc(JE.t('listPlaceholders_import_paste_hint'))}</div>
                        <div class="je-lp-import-parse" aria-live="polite"></div>
                    </div>
                    <div class="je-lp-pane" data-pane="url" hidden>
                        <label class="je-lp-field"><span>${esc(JE.t('listPlaceholders_import_url_label'))}</span>
                            <input type="url" class="je-lp-input je-lp-import-url" autocomplete="off" spellcheck="false" placeholder="https://mdblist.com/lists/…"></label>
                        <div class="je-lp-muted je-lp-import-providers"></div>
                        <div class="je-lp-import-url-error" role="alert"></div>
                    </div>
                </div>
                <div class="je-lp-import-review" hidden>
                    <div class="je-lp-import-head">
                        <button type="button" class="je-lp-link-btn je-lp-import-back"><span class="material-icons" aria-hidden="true">arrow_back</span><span>${esc(JE.t('listPlaceholders_import_back'))}</span></button>
                        <div class="je-lp-import-source je-lp-muted"></div>
                    </div>
                    <div class="je-lp-import-progress" aria-live="polite">
                        <progress class="je-lp-import-bar" max="1" value="0"></progress>
                        <span class="je-lp-import-progress-text"></span>
                    </div>
                    <div class="je-lp-import-summary" aria-live="polite"></div>
                    <div class="je-lp-import-tools">
                        <button type="button" class="je-lp-toolbar-btn je-lp-import-accept">${esc(JE.t('listPlaceholders_import_accept_high'))}</button>
                        <button type="button" class="je-lp-toolbar-btn je-lp-import-retry" hidden></button>
                        <label class="je-lp-check"><input type="checkbox" class="je-lp-import-only-review"> ${esc(JE.t('listPlaceholders_import_only_review'))}</label>
                    </div>
                    <div class="je-lp-import-rows" role="list" aria-label="${esc(JE.t('listPlaceholders_import_rows_label'))}"></div>
                    <div class="je-lp-import-options">
                        <div class="je-lp-import-sync" hidden>
                            <label class="je-lp-check"><input type="checkbox" class="je-lp-import-keep-sync" checked> ${esc(JE.t('listPlaceholders_sourceKeepInSync'))}</label>
                            <label class="je-lp-check"><input type="checkbox" class="je-lp-import-remove-dropped"> ${esc(JE.t('listPlaceholders_sourceRemoveDropped'))}</label>
                            <div class="je-lp-muted je-lp-import-sync-note"></div>
                        </div>
                        ${isNew ? `<div class="je-lp-new-playlist">
                            <label class="je-lp-field"><span>${esc(JE.t('listPlaceholders_new_playlist_name'))}</span><input type="text" class="je-lp-input je-lp-new-name" maxlength="200"></label>
                            <label class="je-lp-check"><input type="checkbox" class="je-lp-new-public"> ${esc(JE.t('listPlaceholders_new_playlist_public'))}</label>
                        </div>` : ''}
                        ${listKind === 'playlist' && !isNew ? `<label class="je-lp-field je-lp-position"><span>${esc(JE.t('listPlaceholders_position'))}</span>
                            <select class="je-lp-select je-lp-import-position">
                                <option value="end">${esc(JE.t('listPlaceholders_position_end'))}</option>
                                <option value="start">${esc(JE.t('listPlaceholders_position_start'))}</option>
                            </select></label>` : ''}
                    </div>
                </div>
            </div>`;

        const modal = JE.jellyseerrModal.create({
            title: JE.t('listPlaceholders_import_title'),
            subtitle: isNew ? JE.t('listPlaceholders_import_new_title') : (ctrl.listName || ''),
            bodyHtml: body,
            buttonText: JE.t('listPlaceholders_import_lookup'),
            onClose: () => {
                state.closed = true;
                clearTimeout(state.parseTimer);
                state.controller?.abort();
                closeEditor();
            },
            onSave: (modalEl, button) => { onPrimary(button); }
        });

        const root = modal.modalElement;
        root.classList.add('je-lp-import-modal');
        const $ = selector => root.querySelector(selector);
        const primary = root.querySelector('.jellyseerr-modal-button-primary');
        const textArea = $('.je-lp-import-text');
        const urlInput = $('.je-lp-import-url');
        const rowsEl = $('.je-lp-import-rows');

        /** @returns {boolean} Whether this modal still belongs to the signed-in user and is open. */
        const alive = () => !state.closed && lp.isCurrentEpoch(state.epoch);

        /**
         * Sets the primary button's text and state.
         * @param {string} text
         * @param {boolean} disabled
         */
        function setPrimary(text, disabled) {
            primary.textContent = text;
            primary.setAttribute('aria-label', text);
            primary.disabled = !!disabled;
        }

        // ── Input step ──

        /**
         * Parses the pasted text and shows the summary and section picker (only when the text changed; sections
         * the user unticked stay unticked).
         */
        function runParse() {
            clearTimeout(state.parseTimer);
            const text = textArea.value;
            if (state.parse && text === state.parsedText) return;
            const target = $('.je-lp-import-parse');
            const unticked = new Set(Array.from(root.querySelectorAll('.je-lp-import-sections input[data-section]')).filter(b => !b.checked).map(b => b.dataset.section));
            state.parsedText = text;
            if (!text.trim()) {
                state.parse = null;
                target.innerHTML = '';
                return;
            }
            state.parse = parser.parse(text);
            const parse = state.parse;
            const parts = [];
            parts.push(`<div>${esc(parse.entries.length ? lp.tn('listPlaceholders_import_parse_summary', { count: parse.entries.length }) : JE.t('listPlaceholders_import_parse_empty'))}`
                + (parse.skipped.length ? ` · <span class="je-lp-muted">${esc(lp.tn('listPlaceholders_import_parse_skipped', { count: parse.skipped.length }))}</span>` : '') + '</div>');
            if (parse.truncated) parts.push(`<div class="je-lp-warn">${esc(JE.t('listPlaceholders_import_parse_truncated', { max: parser.MAX_ENTRIES || MAX_APPLY }))}</div>`);
            const listUrl = parse.skipped.find(s => s.reason === 'listUrl');
            if (listUrl) {
                parts.push(`<button type="button" class="je-lp-link-btn je-lp-import-use-url" data-url="${esc(listUrlOf(listUrl.raw))}"><span class="material-icons" aria-hidden="true">link</span><span>${esc(JE.t('listPlaceholders_import_use_url', { provider: providerName(listUrl.provider) }))}</span></button>`);
            }
            const sections = sectionsOf(parse.entries);
            if (sections.length > 1) {
                parts.push(`<fieldset class="je-lp-import-sections"><legend>${esc(JE.t('listPlaceholders_import_sections'))}</legend>`
                    + sections.map(s => `<label class="je-lp-check"><input type="checkbox"${unticked.has(s.key) ? '' : ' checked'} data-section="${esc(s.key)}"> ${esc(JE.t('listPlaceholders_import_section_count', { title: s.title || JE.t('listPlaceholders_import_section_none'), count: s.count }))}</label>`).join('')
                    + '</fieldset>');
            }
            target.innerHTML = parts.join('');
        }

        /**
         * The first URL in a skipped line.
         * @param {string} raw
         * @returns {string}
         */
        function listUrlOf(raw) {
            const match = /https?:\/\/[^\s<>)]+/i.exec(String(raw || ''));
            return match ? match[0] : String(raw || '').replace(/^<|>$/g, '').trim();
        }

        /**
         * Display name of a list site.
         * @param {string} provider
         * @returns {string}
         */
        function providerName(provider) {
            return { mdblist: 'MDBList', tmdb: 'TMDB', trakt: 'Trakt', imdb: 'IMDb', letterboxd: 'Letterboxd', chronolists: 'chronolists.com' }[provider] || String(provider || '');
        }

        /**
         * Switches between the Paste and From URL tabs.
         * @param {'paste'|'url'} tab
         */
        function showTab(tab) {
            state.tab = tab;
            root.querySelectorAll('.je-lp-import .je-lp-tab').forEach((t) => {
                const active = t.dataset.tab === tab;
                t.classList.toggle('je-lp-tab-active', active);
                t.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            root.querySelectorAll('.je-lp-import .je-lp-pane').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
            if (tab === 'url') {
                loadProviders();
                setTimeout(() => urlInput.focus(), 0);
            } else {
                setTimeout(() => textArea.focus(), 0);
            }
        }

        /** Loads which URL sources work here (once) and lists them. */
        async function loadProviders() {
            if (state.providers) return;
            state.providers = {};
            try {
                state.providers = await lp.api.getSourceProviders() || {};
            } catch (_) {
                state.providers = {};
            }
            if (!alive()) return;
            const p = state.providers;
            const names = [p.mdblist !== false && 'MDBList', (p.tmdbLists || p.tmdbCharts) && 'TMDB', p.trakt && 'Trakt', p.chronolists && 'chronolists.com', p.imdb && 'IMDb'].filter(Boolean);
            const lines = [JE.t('listPlaceholders_import_url_sources', { sources: names.join(', ') }), JE.t('listPlaceholders_sourceLetterboxd')];
            if (p.imdb) lines.push(JE.t('listPlaceholders_sourceImdbUnofficial'));
            $('.je-lp-import-providers').innerHTML = lines.map(l => `<div>${esc(l)}</div>`).join('');
        }

        /** Entries of the chosen sections of the paste. @returns {Array<Object>} */
        function chosenPasteEntries() {
            runParse();
            const parse = state.parse;
            if (!parse) return [];
            const boxes = Array.from(root.querySelectorAll('.je-lp-import-sections input[data-section]'));
            if (!boxes.length) return parse.entries;
            const keep = new Set(boxes.filter(b => b.checked).map(b => b.dataset.section));
            return parse.entries.filter(e => keep.has(e.section || NO_SECTION));
        }

        /**
         * Builds review rows from entries (keeps duplicate hints that point inside the selection).
         * @param {Array<Object>} entries
         * @returns {Array<Object>}
         */
        function makeRows(entries) {
            const byParseIndex = new Map();
            return entries.map((entry, i) => {
                const row = { i, entry, result: null, failed: false, cands: [], cand: -1, both: false, action: 'skip', override: null, confirmed: false, decided: false };
                if (entry.dupOf !== undefined && byParseIndex.has(entry.dupOf)) {
                    row.dupOf = byParseIndex.get(entry.dupOf);
                    row.dupOfLine = entries[row.dupOf]?.line ?? row.dupOf + 1;
                }
                if (entry.index !== undefined && !byParseIndex.has(entry.index)) byParseIndex.set(entry.index, i);
                return row;
            });
        }

        /** Primary button on the input step: parse or fetch, then resolve. */
        async function startFromInput() {
            const urlError = $('.je-lp-import-url-error');
            urlError.textContent = '';
            let entries;
            state.fetched = null;
            if (state.tab === 'url') {
                const url = urlInput.value.trim();
                if (!url) {
                    urlError.textContent = JE.t('listPlaceholders_import_url_required');
                    urlInput.focus();
                    return;
                }
                setPrimary(JE.t('listPlaceholders_import_fetching'), true);
                state.controller = new AbortController();
                try {
                    state.fetched = await fetchWithRetry(url, state.controller.signal);
                } catch (error) {
                    if (!alive() || error?.name === 'AbortError') return;
                    urlError.textContent = sourceErrorText(error);
                    setPrimary(JE.t('listPlaceholders_import_lookup'), false);
                    return;
                }
                if (!alive()) return;
                entries = (state.fetched.entries || []).map((e, i) => ({ ...e, index: i, raw: e.title || e.sourceKey || '' }));
                if (!entries.length) {
                    urlError.textContent = JE.t('listPlaceholders_import_url_empty');
                    setPrimary(JE.t('listPlaceholders_import_lookup'), false);
                    return;
                }
            } else {
                entries = chosenPasteEntries();
                if (!entries.length) {
                    JE.toast(esc(JE.t('listPlaceholders_import_parse_empty')), 3000);
                    textArea.focus();
                    return;
                }
            }
            if (entries.length > MAX_APPLY) entries = entries.slice(0, MAX_APPLY);
            state.rows = makeRows(entries);
            // Exact sources (chronolists): the server already resolved these entries; they skip /resolve.
            const prepared = state.rows.filter(r => r.entry?.prepared && typeof r.entry.prepared === 'object');
            if (prepared.length) applyResults(prepared, prepared.map(r => ({ ...r.entry.prepared, index: r.i })));
            state.requestId = lp.newRequestId();
            showReview();
            await resolveAll();
        }

        /**
         * POST /source/fetch, retrying a parental-controls check that is still running.
         * @param {string} url
         * @param {AbortSignal} signal
         * @returns {Promise<Object>}
         */
        async function fetchWithRetry(url, signal) {
            for (let attempt = 0; ; attempt++) {
                try {
                    return await lp.api.fetchSource(url, { signal, listId });
                } catch (error) {
                    if (error?.responseJSON?.code === 'parental_pending' && attempt < MAX_CHUNK_RETRIES) {
                        await sleep(retryDelay(error), signal);
                        continue;
                    }
                    throw error;
                }
            }
        }

        // ── Resolve ──

        /** Shows the review step (rows fill in as chunks resolve). */
        function showReview() {
            state.step = 'resolving';
            closeEditor();
            $('.je-lp-import-input').hidden = true;
            $('.je-lp-import-review').hidden = false;
            $('.je-lp-import-progress').hidden = false;
            $('.je-lp-import-tools').hidden = true;
            rowsEl.textContent = '';
            rowsEl.classList.remove('je-lp-only-review');
            $('.je-lp-import-only-review').checked = false;
            const fetched = state.fetched;
            const source = $('.je-lp-import-source');
            const fetchedCount = (fetched?.entries || []).length;
            const fetchedTitle = fetched ? (fetched.title || providerName(fetched.kind)) : '';
            source.textContent = !fetched ? ''
                : fetched.grouped && Number(fetched.total) > fetchedCount
                    ? lp.tn('listPlaceholders_import_fetched_grouped', { title: fetchedTitle, count: fetchedCount, total: Number(fetched.total) })
                    : lp.tn('listPlaceholders_import_fetched', { title: fetchedTitle, count: fetchedCount });
            const syncBox = $('.je-lp-import-sync');
            syncBox.hidden = !fetched;
            if (fetched) {
                const notes = [];
                if (fetched.truncated) notes.push(JE.t('listPlaceholders_sourceSyncTruncated', { max: (fetched.entries || []).length }));
                if (fetched.partial) {
                    // Some sources (IMDb) say they are partial without knowing how many entries are missing.
                    const dropped = Number(fetched.dropped) || 0;
                    notes.push(dropped > 0 ? JE.t('listPlaceholders_sourcePartial', { count: dropped }) : JE.t('listPlaceholders_sourcePartialUnknown'));
                }
                if (fetched.unofficial) notes.push(JE.t('listPlaceholders_sourceImdbUnofficial'));
                if (state.providers && state.providers.syncEnabled === false) notes.push(JE.t('listPlaceholders_import_sync_off'));
                $('.je-lp-import-sync-note').textContent = notes.join(' ');
            }
            const nameInput = $('.je-lp-new-name');
            if (nameInput && !nameInput.value.trim()) {
                // A paste of one section (or one section picked) is named after its heading.
                const sections = state.tab === 'paste' ? sectionsOf(state.rows.map(r => r.entry)) : [];
                const sectionTitle = sections.length === 1 ? sections[0].title : '';
                nameInput.value = clip(fetched?.title || (fetched ? nameFromUrl(fetched.url, providerName(fetched.kind)) : '') || sectionTitle || options.name || '', 200);
            }
            updateProgress(0);
            setPrimary(JE.t('listPlaceholders_import_looking_up_short'), true);
        }

        /**
         * Updates the progress bar.
         * @param {number} done - Resolved entries.
         */
        function updateProgress(done) {
            const total = state.rows.length;
            const bar = $('.je-lp-import-bar');
            bar.max = Math.max(1, total);
            bar.value = done;
            $('.je-lp-import-progress-text').textContent = JE.t('listPlaceholders_import_looking_up', { done, total });
        }

        /**
         * Resolves every row in sequential chunks, then resubmits transient rows once. Rows that already have a result
         * (prepared by the server for exact sources) are only rendered, a chunk per task.
         */
        async function resolveAll() {
            const controller = new AbortController();
            state.controller = controller;
            const signal = controller.signal;
            const rows = state.rows;
            let done = 0;
            let appended = 0;
            try {
                for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
                    const chunk = rows.slice(start, start + CHUNK_SIZE);
                    const pending = chunk.filter(r => !r.result);
                    if (pending.length) await resolveChunk(pending, signal);
                    else await sleep(0, signal); // keeps rendering hundreds of prepared rows in short tasks
                    if (!alive() || signal.aborted) return;
                    done += chunk.length;
                    appendRows(chunk);
                    appended = start + chunk.length;
                    updateProgress(done);
                }
                const transient = rows.filter(r => r.transient);
                for (let start = 0; start < transient.length; start += CHUNK_SIZE) {
                    const chunk = transient.slice(start, start + CHUNK_SIZE);
                    await resolveChunk(chunk, signal);
                    if (!alive() || signal.aborted) return;
                    chunk.forEach(row => { if (row.transient) { row.transient = false; row.failed = true; row.action = 'skip'; } });
                    refreshRows(chunk);
                }
            } catch (error) {
                if (!alive() || error?.name === 'AbortError') return;
                const text = error?.jeImportFatal || JE.t('listPlaceholders_err_generic');
                $('.je-lp-import-progress-text').textContent = text;
                JE.toast(esc(text), 6000);
                // Keep what resolved so far reviewable; the rest stays failed.
                rows.filter(r => !r.result).forEach((row) => { row.failed = true; row.transient = false; row.action = 'skip'; });
                refreshRows(rows.slice(0, appended).filter(r => r.failed));
                appendRows(rows.slice(appended));
            }
            if (!alive() || signal.aborted) return;
            finishResolve();
        }

        /**
         * Resolves one chunk: retries busy / parental-pending answers, stops on errors that can't heal.
         * @param {Array<Object>} chunk
         * @param {AbortSignal} signal
         * @returns {Promise<void>}
         */
        async function resolveChunk(chunk, signal) {
            const entries = chunk.map(row => toImportEntry(row.entry, row.i));
            let networkRetries = 0;
            for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
                let response;
                try {
                    response = await lp.api.resolveEntries(entries, { listId, signal });
                } catch (error) {
                    if (error?.name === 'AbortError' || signal.aborted) throw abortError();
                    const code = error?.responseJSON?.code;
                    if (error?.status === 429 || (error?.status === 504 && code === 'parental_pending')) {
                        await sleep(retryDelay(error), signal);
                        continue;
                    }
                    const fatal = fatalResolveText(error);
                    if (fatal) {
                        const stop = new Error(fatal);
                        stop.jeImportFatal = fatal;
                        throw stop;
                    }
                    if (networkRetries++ < 1) {
                        await sleep(RETRY_DELAY_MS, signal);
                        continue;
                    }
                    break;
                }
                applyResults(chunk, response?.results || []);
                return;
            }
            chunk.forEach((row) => { row.transient = true; });
        }

        /**
         * Stores a chunk's results on its rows and picks the default decision.
         * @param {Array<Object>} chunk
         * @param {Array<Object>} results - ResolvedEntryDto list.
         */
        function applyResults(chunk, results) {
            const byIndex = new Map(results.map(r => [r.index, r]));
            for (const row of chunk) {
                const result = byIndex.get(row.i);
                if (!result || result.state === 'transient') {
                    row.transient = true;
                    continue;
                }
                row.transient = false;
                row.failed = false;
                row.result = result;
                row.cands = candidateList(result);
                // No match (confidence none): the candidates stay pickable in "Change match", but the row shows the line.
                row.cand = result.match ? Math.max(0, row.cands.findIndex(c => sameCandidate(c, result.match))) : -1;
                row.decided = false;
                delete row.sameAs;
                row.action = defaultAction(row, listKind);
            }
            // A pasted row that resolves to the same title as an earlier imported row would be dropped by the server: it
            // waits for review as "Skip" (the earlier row keeps its own slot and note). A list source's entry is only
            // flagged: sent as it is, the server counts it as present instead of the sync declining it for good.
            const inChunk = new Set(chunk);
            const changed = new Set(markSameTitles(state.rows, listKind));
            for (const row of chunk) {
                if (row.sameAs !== undefined && row.result && !row.entry?.sourceKey) row.action = 'skip';
            }
            // A late answer (a retried lookup) can flag a row after it that is already shown: it waits for review the
            // same way unless the user settled it.
            for (const row of changed) {
                if (inChunk.has(row) || row.sameAs === undefined || !row.result || row.entry?.sourceKey || row.decided || row.confirmed) continue;
                row.action = 'skip';
            }
            // Rows now skipped no longer claim their titles: flag again, then re-render the shown rows that changed.
            markSameTitles(state.rows, listKind).forEach(row => changed.add(row));
            refreshRows(Array.from(changed).filter(row => !inChunk.has(row)));
        }

        /** Re-flags same-title rows after a change and re-renders the rows whose flag changed. */
        function refreshSameTitles() {
            refreshRows(markSameTitles(state.rows, listKind));
        }

        /**
         * Appends rows to the review list (one parse per chunk; rows use content-visibility).
         * @param {Array<Object>} rows
         */
        function appendRows(rows) {
            if (!rows.length) return;
            rowsEl.insertAdjacentHTML('beforeend', rows.map(row => rowHtml(row, { listKind })).join(''));
        }

        /**
         * Re-renders one row in place.
         * @param {Object} row
         */
        function refreshRow(row) {
            const el = rowsEl.querySelector(`.je-lp-irow[data-i="${row.i}"]`);
            if (!el) return;
            const template = document.createElement('template');
            template.innerHTML = rowHtml(row, { listKind });
            const fresh = template.content.firstElementChild;
            const hadFocus = el.contains(document.activeElement) ? (document.activeElement.classList.contains('je-lp-irow-edit') ? '.je-lp-irow-edit' : '.je-lp-irow-action') : null;
            el.replaceWith(fresh);
            if (hadFocus) fresh.querySelector(hadFocus)?.focus();
        }

        /**
         * Re-renders several rows with one HTML parse (bulk changes stay a single short task).
         * @param {Array<Object>} rows
         */
        function refreshRows(rows) {
            if (!rows.length) return;
            const template = document.createElement('template');
            template.innerHTML = rows.map(row => rowHtml(row, { listKind })).join('');
            const fresh = Array.from(template.content.children);
            rows.forEach((row, index) => {
                rowsEl.querySelector(`.je-lp-irow[data-i="${row.i}"]`)?.replaceWith(fresh[index]);
            });
        }

        /** Resolution finished: show the tools, summary and the Import button. */
        function finishResolve() {
            state.step = 'review';
            state.controller = null;
            $('.je-lp-import-progress').hidden = true;
            $('.je-lp-import-tools').hidden = false;
            updateSummary();
            (rowsEl.querySelector('.je-lp-irow-review .je-lp-irow-action') || rowsEl.querySelector('.je-lp-irow-action'))?.focus({ preventScroll: true });
        }

        /** Updates the summary line, the retry button and the primary button's count. */
        function updateSummary() {
            const counts = summarize(state.rows, listKind);
            $('.je-lp-import-summary').textContent = lp.tn('listPlaceholders_import_review_summary', counts, 'total');
            const retry = $('.je-lp-import-retry');
            retry.hidden = counts.failed === 0 || state.step !== 'review';
            retry.textContent = JE.t('listPlaceholders_import_retry_failed', { count: counts.failed });
            if (state.step === 'review') setPrimary(JE.t('listPlaceholders_import_apply', { count: counts.entries }), counts.entries === 0);
        }

        /** Looks up the failed rows again. */
        async function retryFailed() {
            const failed = state.rows.filter(r => r.failed);
            if (!failed.length || state.step !== 'review') return;
            state.step = 'resolving';
            closeEditor();
            setPrimary(JE.t('listPlaceholders_import_looking_up_short'), true);
            $('.je-lp-import-retry').hidden = true;
            const controller = new AbortController();
            state.controller = controller;
            try {
                for (let start = 0; start < failed.length; start += CHUNK_SIZE) {
                    const chunk = failed.slice(start, start + CHUNK_SIZE);
                    await resolveChunk(chunk, controller.signal);
                    if (!alive() || controller.signal.aborted) return;
                    chunk.forEach((row) => { if (row.transient) { row.transient = false; row.failed = true; } });
                    refreshRows(chunk);
                }
            } catch (error) {
                if (!alive() || error?.name === 'AbortError') return;
                JE.toast(esc(error?.jeImportFatal || JE.t('listPlaceholders_err_generic')), 6000);
            }
            if (!alive() || controller.signal.aborted) return;
            finishResolve();
        }

        /** Back to the input step (aborts a running lookup; not while an import is being applied). */
        function backToInput() {
            if (state.step === 'applying' || state.step === 'retry') return;
            state.controller?.abort();
            state.controller = null;
            closeEditor();
            state.step = 'input';
            state.rows = [];
            rowsEl.textContent = '';
            $('.je-lp-import-review').hidden = true;
            $('.je-lp-import-input').hidden = false;
            setPrimary(JE.t('listPlaceholders_import_lookup'), false);
            (state.tab === 'url' ? urlInput : textArea).focus();
        }

        // ── Row editor (Change match) ──

        /** Closes the inline editor (if open). */
        function closeEditor() {
            const editor = state.editor;
            if (!editor) return;
            state.editor = null;
            clearTimeout(editor.searchTimer);
            editor.searchController?.abort();
            editor.granularity?.destroy();
            editor.element.remove();
            const button = rowsEl.querySelector(`.je-lp-irow[data-i="${editor.row.i}"] .je-lp-irow-edit`);
            button?.setAttribute('aria-expanded', 'false');
            if (editor.restoreFocus) button?.focus();
        }

        /**
         * Opens the inline "Change match" editor under a row: candidates (both versions of an "A or B" line),
         * a Seerr search for another title, and the shared TV granularity picker (B8).
         * @param {Object} row
         */
        function openEditor(row) {
            const wasOpen = state.editor?.row === row;
            closeEditor();
            if (wasOpen) return;
            const rowEl = rowsEl.querySelector(`.je-lp-irow[data-i="${row.i}"]`);
            if (!rowEl) return;
            const editor = { row, element: document.createElement('div'), cands: row.cands.slice(), chosen: row.cand, granularity: null, searchTimer: null, searchController: null, restoreFocus: true };
            const uid = `je-lp-ied-${row.i}`;
            editor.element.className = 'je-lp-ieditor';
            editor.element.setAttribute('role', 'group');
            editor.element.setAttribute('aria-label', JE.t('listPlaceholders_import_change'));
            const showBoth = alternativePicks(row).length > 1;
            editor.element.innerHTML = `
                <div class="je-lp-ieditor-cands" role="radiogroup" aria-label="${esc(JE.t('listPlaceholders_import_candidates'))}"></div>
                ${showBoth ? `<label class="je-lp-check"><input type="checkbox" class="je-lp-ieditor-both"${row.both ? ' checked' : ''}> ${esc(JE.t('listPlaceholders_import_both'))}</label>` : ''}
                ${JE.jellyseerrAPI?.search ? `<input type="search" class="je-lp-input je-lp-ieditor-query" autocomplete="off" placeholder="${esc(JE.t('listPlaceholders_import_search_other'))}" aria-label="${esc(JE.t('listPlaceholders_import_search_other'))}">
                <div class="je-lp-muted je-lp-ieditor-status" aria-live="polite"></div>` : ''}
                <div class="je-lp-ieditor-gran"></div>
                <div class="je-lp-ieditor-actions">
                    <button type="button" class="jellyseerr-modal-button jellyseerr-modal-button-secondary je-lp-ieditor-cancel">${esc(JE.t('jellyseerr_modal_cancel'))}</button>
                    <button type="button" class="jellyseerr-modal-button jellyseerr-modal-button-primary je-lp-ieditor-done">${esc(JE.t('listPlaceholders_import_done'))}</button>
                </div>`;
            const candsEl = editor.element.querySelector('.je-lp-ieditor-cands');
            const statusEl = editor.element.querySelector('.je-lp-ieditor-status');
            const doneButton = editor.element.querySelector('.je-lp-ieditor-done');

            /** Renders the candidate radios. */
            const renderCands = () => {
                if (!editor.cands.length) {
                    candsEl.innerHTML = `<div class="je-lp-muted">${esc(JE.t('listPlaceholders_import_reason_no_match'))}</div>`;
                    return;
                }
                candsEl.innerHTML = editor.cands.map((cand, index) => {
                    const extra = [
                        showBoth && Number.isInteger(cand.alternative) ? esc(JE.t('listPlaceholders_import_version', { number: cand.alternative + 1 })) : '',
                        libraryChipText(cand, listKind) ? `<span class="je-lp-inlib">${esc(libraryChipText(cand, listKind))}</span>` : ''
                    ].filter(Boolean).join(' · ');
                    return `<label class="je-lp-ieditor-cand"><input type="radio" name="${uid}" value="${index}"${index === editor.chosen ? ' checked' : ''}>`
                        + `<img loading="lazy" alt="" src="${esc(lp.render.posterUrl(cand.posterPath, 'w92'))}">`
                        + `<span class="je-lp-result-text"><span class="je-lp-result-title">${esc(candidateLabel(cand))}</span>${extra ? `<span class="je-lp-muted">${extra}</span>` : ''}</span></label>`;
                }).join('');
            };

            /** (Re)creates the granularity picker for a chosen TV candidate. */
            const renderGranularity = () => {
                editor.granularity?.destroy();
                editor.granularity = null;
                doneButton.disabled = false;
                const mount = editor.element.querySelector('.je-lp-ieditor-gran');
                mount.textContent = '';
                const cand = editor.cands[editor.chosen];
                const both = editor.element.querySelector('.je-lp-ieditor-both')?.checked;
                if (!cand || cand.mediaType !== 'tv' || both || !lp.granularity?.create || !JE.jellyseerrAPI?.fetchTvShowDetails) return;
                const current = (editor.chosen === row.cand && row.override) || placeholderFromCandidate(cand, row.entry, row.result?.kind);
                const initial = current ? { kind: current.kind, seasonNumber: current.seasonNumber, episodes: (current.episodes || []).map(e => e.e) } : undefined;
                const picker = lp.granularity.create({ tmdbId: Number(cand.tmdbId), initial });
                editor.granularity = picker;
                mount.appendChild(picker.element);
                // A season/episode choice can only be read once the seasons are loaded: Done waits for them.
                doneButton.disabled = true;
                Promise.resolve(picker.ready).catch(() => {}).then(() => {
                    if (state.editor === editor && editor.granularity === picker) doneButton.disabled = false;
                });
            };

            /** Runs the Seerr search for another title. */
            const runSearch = async () => {
                const input = editor.element.querySelector('.je-lp-ieditor-query');
                const query = input?.value.trim() || '';
                editor.searchController?.abort();
                if (query.length < 2) {
                    statusEl.textContent = '';
                    return;
                }
                const controller = new AbortController();
                editor.searchController = controller;
                statusEl.textContent = JE.t('listPlaceholders_import_searching');
                try {
                    const data = await JE.jellyseerrAPI.search(query, 1, { signal: controller.signal, throwOnError: true });
                    if (controller.signal.aborted || state.editor !== editor) return;
                    const found = (lp.search?.usableResults ? lp.search.usableResults(data?.results) : (data?.results || []))
                        .slice(0, 8)
                        .map(r => ({
                            mediaType: r.mediaType,
                            tmdbId: Number(r.id),
                            title: r.title || r.name || '',
                            releaseDate: cleanDate(r.mediaType === 'tv' ? r.firstAirDate : r.releaseDate),
                            year: cleanYear(String((r.mediaType === 'tv' ? r.firstAirDate : r.releaseDate) || '').slice(0, 4)),
                            posterPath: r.posterPath,
                            overview: r.overview,
                            searched: true
                        }));
                    const keep = editor.cands.filter(c => !c.searched || c === editor.cands[editor.chosen]);
                    const chosen = editor.cands[editor.chosen];
                    const added = found.filter(f => !keep.some(k => sameCandidate(k, f)));
                    editor.cands = keep.concat(added);
                    editor.chosen = chosen ? editor.cands.indexOf(chosen) : -1;
                    renderCands();
                    // Say so when the search found nothing, or only titles that are already listed.
                    statusEl.textContent = added.length ? '' : JE.t(found.length ? 'listPlaceholders_import_search_no_new' : 'listPlaceholders_import_search_none', { query });
                } catch (error) {
                    if (error?.name === 'AbortError' || controller.signal.aborted) return;
                    statusEl.textContent = JE.t('listPlaceholders_search_failed');
                }
            };

            editor.element.addEventListener('change', (e) => {
                if (e.target.name === uid) {
                    editor.chosen = Number(e.target.value);
                    renderGranularity();
                } else if (e.target.classList.contains('je-lp-ieditor-both')) {
                    renderGranularity();
                }
            });
            editor.element.querySelector('.je-lp-ieditor-query')?.addEventListener('input', () => {
                clearTimeout(editor.searchTimer);
                editor.searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
            });
            editor.element.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    closeEditor();
                } else if (e.key === 'Enter' && e.target.classList.contains('je-lp-ieditor-query')) {
                    e.preventDefault();
                    clearTimeout(editor.searchTimer);
                    runSearch();
                }
            });
            editor.element.querySelector('.je-lp-ieditor-cancel').addEventListener('click', () => closeEditor());
            doneButton.addEventListener('click', () => {
                if (doneButton.disabled) return;
                const cand = editor.cands[editor.chosen];
                if (!cand) {
                    closeEditor();
                    return;
                }
                const both = !!editor.element.querySelector('.je-lp-ieditor-both')?.checked;
                let override = null;
                if (!both && cand.mediaType === 'tv' && editor.granularity?.getDetails()) {
                    const selection = editor.granularity.getSelection();
                    if (selection === null) {
                        JE.toast(esc(JE.t('listPlaceholders_pick_episode')), 3000);
                        return;
                    }
                    // A dateless (announced) show keeps the line's year, as placeholderFromCandidate does.
                    const year = cleanYear(cand.year) || (cleanDate(cand.releaseDate) ? undefined : lineYear(row.entry));
                    override = lp.granularity.toPlaceholder({ id: cand.tmdbId, mediaType: 'tv', name: cand.title, firstAirDate: cand.releaseDate, year, posterPath: cand.posterPath, overview: cand.overview, tvdbId: cand.tvdbId }, selection, editor.granularity.getDetails());
                    if (override) {
                        const note = clip(row.entry.note, 300);
                        if (note) override.note = note;
                        if (IMDB_RE.test(cand.imdbId || '')) override.imdbId = cand.imdbId;
                    }
                }
                const scopeChanged = !!override || !!cand.searched;
                row.cands = editor.cands.filter(c => !c.searched || c === cand);
                row.cand = row.cands.indexOf(cand);
                row.both = both;
                row.override = override;
                row.confirmed = true;
                row.action = fromLibrary(cand, listKind) && !override ? 'item' : 'placeholder';
                closeEditor();
                refreshRow(row);
                refreshSameTitles();
                updateSummary();
                // A searched title or another season/episodes: what the library has of it isn't known yet. The server puts
                // that in anyway; look it up so the row says so ("From your library", "n of m episodes in your library").
                if (scopeChanged && !both) checkLibrary(row, cand, override);
            });

            renderCands();
            renderGranularity();
            rowEl.after(editor.element);
            rowEl.querySelector('.je-lp-irow-edit')?.setAttribute('aria-expanded', 'true');
            state.editor = editor;
            (editor.element.querySelector(`input[name="${uid}"]:checked`) || editor.element.querySelector('input'))?.focus();
        }

        /**
         * Looks up what the library has of a changed match (its TMDB id and chosen scope, through /resolve) and shows it
         * on the row: the candidate gets the fresh inLibrary and the row becomes "From your library" when the import
         * would bring in library items.
         * @param {Object} row
         * @param {Object} cand - The chosen candidate.
         * @param {Object|null} override - The chosen season/episodes placeholder, if any.
         */
        async function checkLibrary(row, cand, override) {
            const scope = override || placeholderFromCandidate(cand, row.entry, row.result?.kind);
            if (!scope) return;
            const probe = { index: 0, title: clip(cand.title, 200), ids: { tmdb: Number(cand.tmdbId), tmdbType: cand.mediaType } };
            if (Number.isInteger(scope.seasonNumber)) probe.season = scope.seasonNumber;
            if (scope.kind === 'episodes') probe.episodes = (scope.episodes || []).slice(0, 100).map(e => ({ s: scope.seasonNumber, e: Number(e.e) }));
            const token = row.libraryToken = (row.libraryToken || 0) + 1;
            row.libraryPending = true;
            refreshRow(row);
            let match = null;
            try {
                const response = await lp.api.resolveEntries([probe], { listId });
                match = response?.results?.[0]?.match || null;
            } catch (_) {
                match = null; // the import still works; the row just doesn't show the library state
            }
            // A row of a review left with Back (a new lookup reuses its index) is gone, not just out of date.
            if (!alive() || row.libraryToken !== token || state.rows[row.i] !== row) return;
            row.libraryPending = false;
            const current = row.cands[row.cand];
            // The probe is a single title, so its match never names an alternative: compare the title only (the
            // candidate keeps its own alternative below).
            if (match && current === cand && match.mediaType === cand.mediaType && Number(match.tmdbId) === Number(cand.tmdbId) && state.step === 'review') {
                // The scope facts of the looked-up scope (season, episodes, episode total) make the chip's "n of m" right.
                const fresh = {
                    ...cand,
                    inLibrary: match.inLibrary || null,
                    tvdbId: cand.tvdbId ?? match.tvdbId,
                    imdbId: cand.imdbId ?? match.imdbId,
                    season: match.season ?? cand.season,
                    episodes: match.episodes ?? cand.episodes,
                    episodeTotal: match.episodeTotal ?? cand.episodeTotal
                };
                row.cands[row.cand] = fresh;
                if (row.action === 'placeholder' && fromLibrary(fresh, listKind)) row.action = 'item';
            }
            refreshRow(row);
            updateSummary();
        }

        // ── Apply ──

        /**
         * Builds the request of an import from the review (null, with a toast, when it can't be sent).
         * @returns {Object|null} Body of POST /playlists (new) or POST /{listId}/apply.
         */
        function buildRequest() {
            state.owners = [];
            const entries = buildEntries(state.rows, listKind, state.owners);
            if (!entries.length) {
                JE.toast(esc(JE.t('listPlaceholders_import_nothing')), 3000);
                return null;
            }
            if (entries.length > MAX_APPLY) {
                JE.toast(esc(JE.t('listPlaceholders_import_too_many', { max: MAX_APPLY })), 4000);
                return null;
            }
            const fetched = state.fetched;
            // Snapshot keys are the rows the reviewer could decide on: the server tombstones the ones not sent as
            // "declined", so a row whose lookup failed stays out and the next sync tries it again.
            const source = fetched ? {
                url: fetched.url,
                syncEnabled: !!$('.je-lp-import-keep-sync').checked,
                removeDropped: !!$('.je-lp-import-remove-dropped').checked,
                snapshotKeys: snapshotKeys(state.rows, fetched)
            } : undefined;
            if (isNew) {
                const name = clip($('.je-lp-new-name').value, 200);
                if (!name) {
                    JE.toast(esc(JE.t('listPlaceholders_new_playlist_name_required')), 3000);
                    $('.je-lp-new-name').focus();
                    return null;
                }
                return { requestId: state.requestId, name, isPublic: !!$('.je-lp-new-public').checked, entries, source };
            }
            const position = listKind === 'playlist' && $('.je-lp-import-position')?.value === 'start' ? { atStart: true } : undefined;
            return { requestId: state.requestId, entries, position, source };
        }

        /**
         * Locks or unlocks every control of the review (rows, tools, options, Back) while an import is sent or
         * awaits an identical retry.
         * @param {boolean} locked
         */
        function lockReview(locked) {
            const review = $('.je-lp-import-review');
            review.classList.toggle('je-lp-import-locked', locked);
            review.querySelectorAll('select, input, textarea, button').forEach((el) => { el.disabled = locked; });
        }

        /**
         * Imports the reviewed entries (existing list or new playlist). After an unconfirmed failure the same request
         * is sent again unchanged: the server may have applied it, and then answers the retry with that result.
         */
        async function applyImport() {
            const request = state.frozen || buildRequest();
            if (!request) return;
            state.step = 'applying';
            closeEditor();
            lockReview(true);
            setPrimary(JE.t('listPlaceholders_import_applying'), true);
            try {
                if (isNew) {
                    const created = await lp.api.createList('playlist', request);
                    if (!lp.isCurrentEpoch(state.epoch)) return;
                    // The import happened even when the modal was closed meanwhile: always report it.
                    reportApplied(created?.result, created?.listId, created?.name || request.name, state.owners);
                    if (state.closed) return;
                    history.back();
                    const id = lp.normalizeId(created?.listId);
                    if (id) setTimeout(() => { window.location.hash = `#/details?id=${id}`; }, 350);
                } else {
                    const result = await lp.api.applyEntries(listId, request);
                    if (!lp.isCurrentEpoch(state.epoch)) return;
                    reportApplied(result, listId, ctrl.listName || '', state.owners);
                    if (result?.addedAsItems?.length) ctrl.afterRealItemsAdded?.();
                    if (!state.closed) history.back();
                }
            } catch (error) {
                if (!alive() || lp.isStaleIdentityError(error)) return;
                const code = error?.responseJSON?.code;
                if (sourceErrorKey(code)) JE.toast(esc(sourceErrorText(error)), 6000);
                else lp.toastError(error);
                if (isUnconfirmedFailure(error)) {
                    // No answer from the plugin (network error, proxy timeout): the import may have been applied.
                    // Edits now would be ignored by a replay, so only the identical request can be retried.
                    state.frozen = request;
                    state.step = 'retry';
                    $('.je-lp-import-summary').textContent = JE.t('listPlaceholders_import_unconfirmed');
                    setPrimary(JE.t('listPlaceholders_import_retry_apply'), false);
                    return;
                }
                // The plugin answered with an error: nothing was recorded for this request id, so edits apply.
                state.frozen = null;
                state.step = 'review';
                lockReview(false);
                updateSummary();
            }
        }

        /**
         * Toast after an import, with a link to the list.
         * @param {Object} result - ApplyResultDto.
         * @param {string} id - List id.
         * @param {string} name - List name.
         */
        function reportApplied(result, id, name, owners) {
            const link = `<a href="#/details?id=${esc(lp.normalizeId(id) || '')}" class="je-lp-toast-link">${esc(name)}</a>`;
            const text = JE.t('listPlaceholders_import_done_toast', {
                list: link,
                placeholders: result?.added?.length || 0,
                items: result?.addedAsItems?.length || 0
            });
            JE.toast(text + skippedText(result?.skipped, owners), 8000);
        }

        /**
         * What the server skipped, by reason, naming the review rows: a repeat of another entry ("row 16 = row 15"),
         * already in the list, or not allowed. Never silent: every skipped row is listed.
         * @param {Array<Object>} skipped - SkippedEntryDto list.
         * @param {Array<Object>} [owners] - The review row of each sent entry.
         * @returns {string} Escaped text with a leading space, or ''.
         */
        function skippedText(skipped, owners) {
            if (!Array.isArray(skipped) || !skipped.length) return '';
            const rowOf = index => owners?.[index]?.i;
            const label = index => (rowOf(index) === undefined ? String(index + 1) : String(rowOf(index) + 1));
            const groups = { same: [], present: [], other: [] };
            for (const skip of skipped) {
                if (Number.isInteger(skip?.sameAs) && skip.sameAs !== skip.index) groups.same.push(`${label(skip.index)} (= ${label(skip.sameAs)})`);
                else if (skip?.reason === 'duplicate' || skip?.reason === 'alreadyInList') groups.present.push(label(skip.index));
                else groups.other.push(label(skip.index));
            }
            const parts = [];
            const unique = list => Array.from(new Set(list));
            if (groups.same.length) parts.push(lp.tn('listPlaceholders_import_done_same', { count: unique(groups.same).length, rows: unique(groups.same).join(', ') }));
            if (groups.present.length) parts.push(lp.tn('listPlaceholders_import_done_present', { count: unique(groups.present).length, rows: unique(groups.present).join(', ') }));
            if (groups.other.length) parts.push(lp.tn('listPlaceholders_import_done_other', { count: unique(groups.other).length, rows: unique(groups.other).join(', ') }));
            return ' ' + esc(parts.join(' '));
        }

        // ── Wiring ──

        /**
         * The primary button: look up, or import.
         * @param {HTMLButtonElement} button
         */
        function onPrimary(button) {
            if (button.disabled) return;
            if (state.step === 'input') startFromInput();
            else if (state.step === 'review' || state.step === 'retry') applyImport();
        }

        root.querySelector('.je-lp-import .je-lp-tabs').addEventListener('click', (e) => {
            const tab = e.target.closest('.je-lp-tab');
            if (tab) showTab(tab.dataset.tab);
        });
        root.querySelector('.je-lp-import .je-lp-tabs').addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const next = state.tab === 'paste' ? 'url' : 'paste';
            showTab(next);
            root.querySelector(`.je-lp-import .je-lp-tab[data-tab="${next}"]`)?.focus();
        });
        textArea.addEventListener('input', () => {
            clearTimeout(state.parseTimer);
            state.parseTimer = setTimeout(runParse, PARSE_DEBOUNCE_MS);
        });
        const submitShortcut = (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.target === urlInput)) {
                e.preventDefault();
                onPrimary(primary);
            }
        };
        textArea.addEventListener('keydown', submitShortcut);
        urlInput.addEventListener('keydown', submitShortcut);
        $('.je-lp-import-parse').addEventListener('click', (e) => {
            const use = e.target.closest('.je-lp-import-use-url');
            if (!use) return;
            urlInput.value = use.dataset.url || '';
            showTab('url');
        });
        $('.je-lp-import-back').addEventListener('click', backToInput);
        $('.je-lp-import-accept').addEventListener('click', () => {
            if (state.step !== 'review') return;
            closeEditor();
            // Sure matches are already in by default, so on a fresh review the work is the likely (medium) ones: their
            // pre-selected match is accepted and they leave "to review"; sure or likely rows set to something else go
            // back to their match. Matches changed with "Change match" stay; repeats of another row and "A or B" lines
            // still need a look.
            const changed = [];
            for (const row of state.rows) {
                const conf = row.result?.confidence;
                if (row.confirmed || (conf !== 'high' && conf !== 'medium') || !row.result.match || row.result.alternatives
                    || row.dupOf !== undefined || row.sameAs !== undefined) continue;
                const cands = candidateList(row.result);
                const cand = Math.max(0, cands.findIndex(c => sameCandidate(c, row.result.match)));
                const action = fromLibrary(cands[cand], listKind) ? 'item' : 'placeholder';
                const same = row.action === action && row.cand === cand && !row.both && !row.override && row.cands.length === cands.length;
                if (same && conf === 'high') continue;
                Object.assign(row, { cands, cand, both: false, override: null, action, confirmed: conf === 'medium', decided: false });
                changed.push(row);
            }
            refreshRows(changed);
            refreshSameTitles();
            updateSummary();
            JE.toast(esc(changed.length ? lp.tn('listPlaceholders_import_accepted', { count: changed.length }) : JE.t('listPlaceholders_import_accepted_none')), 3000);
        });
        $('.je-lp-import-retry').addEventListener('click', retryFailed);
        $('.je-lp-import-only-review').addEventListener('change', (e) => {
            rowsEl.classList.toggle('je-lp-only-review', e.target.checked);
        });
        rowsEl.addEventListener('change', (e) => {
            const select = e.target.closest('.je-lp-irow-action');
            if (!select || state.step !== 'review') return;
            const row = state.rows[Number(select.closest('.je-lp-irow')?.dataset.i)];
            if (!row) return;
            row.action = select.value;
            row.decided = true; // the user settled it: no longer "to review"
            refreshRow(row);
            refreshSameTitles();
            updateSummary();
        });
        rowsEl.addEventListener('click', (e) => {
            const button = e.target.closest('.je-lp-irow-edit');
            if (!button) return;
            const row = state.rows[Number(button.closest('.je-lp-irow')?.dataset.i)];
            if (row && state.step === 'review') openEditor(row);
        });

        modal.show();
        if (options.text) {
            textArea.value = String(options.text);
            runParse();
        }
        if (options.url) {
            urlInput.value = String(options.url);
            showTab('url');
        } else {
            setTimeout(() => textArea.focus(), 50);
        }
        return modal;
    }

    lp.importer = {
        open,
        toImportEntry,
        candidateList,
        libraryItemFor,
        fromLibrary,
        libraryChipText,
        placeholderFromCandidate,
        customFromEntry,
        defaultAction,
        needsReview,
        rowEntries,
        buildEntries,
        summarize,
        sectionsOf,
        rowHtml,
        plainLine,
        nameFromUrl,
        sourceErrorText,
        sourceErrorKey,
        isUnconfirmedFailure,
        snapshotKeys,
        fatalResolveText,
        CHUNK_SIZE
    };

})(window.JellyfinEnhanced);
