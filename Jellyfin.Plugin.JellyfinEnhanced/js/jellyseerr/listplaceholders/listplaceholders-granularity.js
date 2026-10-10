// /js/jellyseerr/listplaceholders/listplaceholders-granularity.js
// Shared TV granularity picker (B8): whole series / one season / episodes of ONE season.
// Seasons and episodes load on demand from Seerr (/tv/{id}, /tv/{id}/season/{n}). Used by
// the Seerr-card picker, Add title and "Link to a title" (and later the import review).
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.listPlaceholders = JE.internals.listPlaceholders || {};

    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    let instanceCounter = 0;

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
     * Seasons worth offering: those with episodes, sorted, specials last.
     * @param {Object} details - Seerr TV details.
     * @returns {Array<Object>}
     */
    function usableSeasons(details) {
        return (details?.seasons || [])
            .filter(s => Number.isInteger(s?.seasonNumber) && s.seasonNumber >= 0 && (s.episodeCount || 0) > 0)
            .slice()
            .sort((a, b) => (a.seasonNumber === 0) - (b.seasonNumber === 0) || a.seasonNumber - b.seasonNumber);
    }

    /**
     * Base placeholder fields from a Seerr search result / details object.
     * @param {Object} media - Seerr item (`id`, `mediaType`, `title|name`, dates, posterPath, overview);
     *   an arr candidate (search.arrMedia) may also carry `year` for titles without a date yet.
     * @returns {Object} Partial NewPlaceholderDto.
     */
    function basePlaceholder(media) {
        const tv = media.mediaType === 'tv';
        const date = cleanDate(tv ? (media.firstAirDate || media.releaseDate) : (media.releaseDate || media.firstAirDate));
        const knownYear = Number(media.year);
        const base = {
            mediaType: tv ? 'tv' : 'movie',
            tmdbId: Number(media.id),
            title: String(media.title || media.name || '').trim().slice(0, 200),
            releaseDate: date,
            year: date ? Number(date.slice(0, 4)) : (Number.isInteger(knownYear) && knownYear >= 1870 && knownYear <= 2100 ? knownYear : undefined),
            overview: media.overview ? String(media.overview).slice(0, 1000) : undefined
        };
        if (lp.render.isSafePoster(media.posterPath)) base.posterPath = media.posterPath;
        const tvdbId = Number(media.externalIds?.tvdbId || media.tvdbId);
        if (tv && Number.isInteger(tvdbId) && tvdbId > 0) base.tvdbId = tvdbId;
        if (!base.year) delete base.year;
        if (!base.overview) delete base.overview;
        return base;
    }

    /**
     * Turns a granularity selection into the placeholder to store (C4 release date per kind).
     * @param {Object} media - Seerr item the user picked.
     * @param {Object|null|undefined} selection - From getSelection() (null = incomplete); undefined
     *   when there was no granularity picker (movies; TV defaults to the whole series).
     * @param {Object|null} details - Seerr TV details (seasons) if loaded.
     * @returns {Object|null} NewPlaceholderDto, or null when the selection is incomplete.
     */
    function toPlaceholder(media, selection, details) {
        const base = basePlaceholder(details ? { ...media, ...details, mediaType: media.mediaType, id: media.id } : media);
        if (base.mediaType === 'movie') return { ...base, kind: 'movie' };
        if (selection === null) return null;
        const sel = selection || { kind: 'series' };
        if (sel.kind === 'series') return { ...base, kind: 'series' };
        const season = usableSeasons(details).find(s => s.seasonNumber === sel.seasonNumber);
        if (sel.kind === 'season') {
            const out = { ...base, kind: 'season', seasonNumber: sel.seasonNumber, releaseDate: cleanDate(season?.airDate) };
            if (season?.episodeCount > 0) out.episodeTotal = season.episodeCount;
            if (out.releaseDate) out.year = Number(out.releaseDate.slice(0, 4)); else delete out.year;
            return out;
        }
        if (sel.kind === 'episodes') {
            const episodes = (sel.episodes || []).slice(0, 100);
            if (!episodes.length) return null;
            const first = episodes[0];
            const out = {
                ...base,
                kind: 'episodes',
                seasonNumber: sel.seasonNumber,
                episodes: episodes.map(e => ({ s: sel.seasonNumber, e: e.e, title: e.title ? String(e.title).slice(0, 200) : undefined, airDate: cleanDate(e.airDate) || undefined })),
                releaseDate: cleanDate(first.airDate) || cleanDate(season?.airDate)
            };
            if (out.releaseDate) out.year = Number(out.releaseDate.slice(0, 4)); else delete out.year;
            return out;
        }
        return null;
    }

    /**
     * Creates the granularity picker for one show.
     * @param {{tmdbId: number, initial?: {kind: string, seasonNumber?: number, episodes?: number[]}}} options
     * @returns {{element: HTMLElement, ready: Promise<void>, getSelection: function(): (Object|null), getDetails: function(): (Object|null), destroy: function(): void}}
     */
    function create(options) {
        const esc = lp.render.esc;
        const uid = `je-lp-gran-${++instanceCounter}`;
        const element = document.createElement('div');
        element.className = 'je-lp-granularity';
        element.innerHTML = `
            <div class="je-lp-gran-modes" role="radiogroup" aria-label="${esc(JE.t('listPlaceholders_granularity'))}">
                <label><input type="radio" name="${uid}" value="series" checked> ${esc(JE.t('listPlaceholders_gran_series'))}</label>
                <label><input type="radio" name="${uid}" value="season" disabled> ${esc(JE.t('listPlaceholders_gran_season'))}</label>
                <label><input type="radio" name="${uid}" value="episodes" disabled> ${esc(JE.t('listPlaceholders_gran_episodes'))}</label>
            </div>
            <div class="je-lp-gran-season" hidden>
                <label for="${uid}-season">${esc(JE.t('listPlaceholders_gran_pick_season'))}</label>
                <select id="${uid}-season" class="je-lp-select"></select>
            </div>
            <div class="je-lp-gran-episodes" hidden></div>
            <div class="je-lp-gran-status" aria-live="polite"></div>`;

        const seasonWrap = element.querySelector('.je-lp-gran-season');
        const seasonSelect = element.querySelector('select');
        const episodesWrap = element.querySelector('.je-lp-gran-episodes');
        const statusEl = element.querySelector('.je-lp-gran-status');
        let details = null;
        let destroyed = false;
        let episodeToken = 0;
        let loadedSeason = null;
        let episodeCache = new Map();

        /** @returns {string} The chosen mode: series, season or episodes. */
        const mode = () => element.querySelector(`input[name="${uid}"]:checked`)?.value || 'series';

        /** Loads the episode checklist of the selected season (episodes mode only). */
        async function loadEpisodes() {
            const season = Number(seasonSelect.value);
            if (mode() !== 'episodes' || !Number.isInteger(season)) return;
            if (loadedSeason === season) return;
            const token = ++episodeToken;
            episodesWrap.innerHTML = `<div class="je-lp-muted">${esc(JE.t('listPlaceholders_loading'))}</div>`;
            let episodes = episodeCache.get(season);
            if (!episodes) {
                const data = await JE.jellyseerrAPI.fetchTvSeasonDetails(options.tmdbId, season);
                episodes = (data?.episodes || []).filter(e => Number.isInteger(e?.episodeNumber));
                if (data) episodeCache.set(season, episodes);
            }
            if (destroyed || token !== episodeToken) return;
            loadedSeason = season;
            if (!episodes.length) {
                episodesWrap.innerHTML = `<div class="je-lp-muted">${esc(JE.t('listPlaceholders_gran_no_episodes'))}</div>`;
                return;
            }
            const initial = new Set(options.initial?.kind === 'episodes' && options.initial.seasonNumber === season ? options.initial.episodes || [] : []);
            episodesWrap.innerHTML = episodes.map(e => `
                <label class="je-lp-episode">
                    <input type="checkbox" value="${esc(e.episodeNumber)}" data-title="${esc(e.name || '')}" data-air="${esc(cleanDate(e.airDate) || '')}"${initial.has(e.episodeNumber) ? ' checked' : ''}>
                    <span class="je-lp-episode-num">E${esc(String(e.episodeNumber).padStart(2, '0'))}</span>
                    <span class="je-lp-episode-title">${esc(e.name || '')}</span>
                    <span class="je-lp-muted">${esc(cleanDate(e.airDate) ? lp.render.formatDate(cleanDate(e.airDate)) : JE.t('listPlaceholders_tba'))}</span>
                </label>`).join('');
        }

        /** Shows the controls for the chosen mode. */
        function sync() {
            const m = mode();
            seasonWrap.hidden = m === 'series';
            episodesWrap.hidden = m !== 'episodes';
            if (m === 'episodes') loadEpisodes();
        }

        element.addEventListener('change', (e) => {
            if (e.target === seasonSelect) {
                loadedSeason = null;
                sync();
            } else if (e.target.name === uid) {
                sync();
            }
        });

        /** @returns {HTMLInputElement[]} The "One season" and "Episodes" radios. */
        const seasonModes = () => Array.from(element.querySelectorAll(`input[name="${uid}"]:not([value="series"])`));

        // "One season" / "Episodes" stay disabled until the seasons are known (and for good when
        // they can't be loaded), so no season choice can be made against an empty season list.
        const ready = (async () => {
            statusEl.textContent = JE.t('listPlaceholders_loading');
            try {
                details = await JE.jellyseerrAPI.fetchTvShowDetails(options.tmdbId);
            } catch (_) {
                details = null;
            }
            if (destroyed) return;
            const seasons = usableSeasons(details);
            statusEl.textContent = '';
            if (!seasons.length) {
                statusEl.textContent = details ? JE.t('listPlaceholders_gran_no_seasons') : JE.t('listPlaceholders_err_generic');
                return;
            }
            seasonSelect.innerHTML = seasons.map(s => {
                const name = s.seasonNumber === 0 ? JE.t('jellyseerr_season_specials') : JE.t('jellyseerr_season_name', { number: s.seasonNumber });
                const meta = [cleanDate(s.airDate)?.slice(0, 4), JE.t('listPlaceholders_episode_count', { count: s.episodeCount })].filter(Boolean).join(' · ');
                return `<option value="${esc(s.seasonNumber)}">${esc(name)} (${esc(meta)})</option>`;
            }).join('');
            seasonModes().forEach((input) => { input.disabled = false; });
            const initial = options.initial;
            if (initial && (initial.kind === 'season' || initial.kind === 'episodes') && seasons.some(s => s.seasonNumber === initial.seasonNumber)) {
                seasonSelect.value = String(initial.seasonNumber);
                const radio = element.querySelector(`input[name="${uid}"][value="${initial.kind}"]`);
                if (radio) radio.checked = true;
            }
            sync();
        })();

        return {
            element,
            ready,
            /**
             * The current choice, or null when it is incomplete (no season loaded, or "episodes" with none ticked).
             * @returns {Object|null}
             */
            getSelection() {
                const m = mode();
                if (m === 'series') return { kind: 'series' };
                // No season loaded/selected: never read '' as season 0 (Specials).
                if (seasonSelect.value === '') return null;
                const seasonNumber = Number(seasonSelect.value);
                if (!Number.isInteger(seasonNumber)) return null;
                if (m === 'season') return { kind: 'season', seasonNumber };
                const episodes = Array.from(episodesWrap.querySelectorAll('input[type=checkbox]:checked')).map(input => ({
                    e: Number(input.value), title: input.dataset.title || undefined, airDate: input.dataset.air || undefined
                }));
                return episodes.length ? { kind: 'episodes', seasonNumber, episodes } : null;
            },
            /** @returns {Object|null} The Seerr TV details once loaded. */
            getDetails() {
                return details;
            },
            /** Stops pending loads from touching the element. */
            destroy() {
                destroyed = true;
                episodeCache = new Map();
            }
        };
    }

    lp.granularity = { create, toPlaceholder, basePlaceholder, usableSeasons };

})(window.JellyfinEnhanced);
