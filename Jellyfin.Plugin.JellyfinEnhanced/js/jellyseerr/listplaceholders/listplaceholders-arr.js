// /js/jellyseerr/listplaceholders/listplaceholders-arr.js
/**
 * @file List placeholders: admin "Add to Radarr / Sonarr".
 * Standalone module: it only defines functions at load (no network, no DOM) and exposes them on
 * `JE.listPlaceholders.arr`. Placeholder menus, collection cards and the admin "Add title" results call
 * `menuItemFor()` / `createAddButton()` / `openAddDialog()`; "Add title" can also show Radarr/Sonarr lookup
 * results through `searchCandidates()` (works without Seerr). Server routes: /JellyfinEnhanced/list-placeholders/arr/*.
 */
(function (JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: List placeholders (arr):';
    const API = '/list-placeholders/arr';
    const OPTIONS_TTL_MS = 60 * 1000;
    const CHOICE_KEY = 'je-lp-arr-choice';
    const STYLE_ID = 'je-lp-arr-styles';
    const RESULT_TOAST_MS = 6000;
    const AVAILABILITIES = ['announced', 'inCinemas', 'released'];
    const SERIES_TYPES = ['standard', 'daily', 'anime'];
    /** Add errors after which the cached options can't be trusted any more. */
    const STALE_OPTION_CODES = new Set(['instance_changed', 'invalid_quality_profile', 'invalid_root_folder', 'arr_unreachable', 'arr_timeout', 'arr_auth_failed', 'not_configured']);

    /** @type {Record<string, {at: number, data: any}>} Per type ("movie", "tv", "all"). */
    let optionsCache = {};
    /** @type {Record<string, Promise<any>>} */
    let optionsInFlight = {};

    /**
     * Current identity epoch (0 when the session module is absent).
     * @returns {number}
     */
    function epochNow() {
        return JE.session?.getEpoch ? JE.session.getEpoch() : 0;
    }

    /**
     * Whether an epoch captured before an await still belongs to the signed-in user.
     * @param {number} epoch
     * @returns {boolean}
     */
    function isCurrentEpoch(epoch) {
        return !JE.session?.isCurrent || JE.session.isCurrent(epoch);
    }

    // Options are per server configuration, the remembered choices per user: drop both on a user switch.
    JE.session?.onUserChange?.('list-placeholders-arr', () => {
        optionsCache = {};
        optionsInFlight = {};
    });

    /**
     * Escapes text for HTML. Also neutralises "$" so the value is safe as a JE.t() replacement.
     * @param {*} value
     * @returns {string}
     */
    function esc(value) {
        const escape = JE.escapeHtml || JE.helpers?.escHtml || ((v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
        return escape(value == null ? '' : String(value)).replace(/\$/g, '&#36;');
    }

    /**
     * Whether the current user may use the arr actions at all (UX gate; the server enforces admin too).
     * @returns {boolean}
     */
    function isAvailable() {
        const config = JE.pluginConfig || {};
        const admin = JE.helpers?.isAdmin ? JE.helpers.isAdmin() : JE.currentSettings?.isAdmin === true;
        return admin === true && config.ListPlaceholdersEnabled === true && config.ListPlaceholdersArrEnabled === true;
    }

    /**
     * Which service handles a placeholder / candidate.
     * @param {object} item - Placeholder (kind, mediaType, ids) or lookup/search candidate (mediaType, ids).
     * @returns {'radarr'|'sonarr'|null} Null for custom entries and items without a usable id.
     */
    function serviceFor(item) {
        if (!item || item.kind === 'custom') return null;
        const tmdb = Number(item.tmdbId) > 0;
        const tvdb = Number(item.tvdbId) > 0;
        const imdb = typeof item.imdbId === 'string' && /^tt\d{5,10}$/i.test(item.imdbId);
        const kind = item.kind;
        const mediaType = kind === 'movie' ? 'movie'
            : (kind === 'series' || kind === 'season' || kind === 'episodes') ? 'tv'
                : item.mediaType;
        if (mediaType === 'movie') return (tmdb || imdb) ? 'radarr' : null;
        if (mediaType === 'tv') return (tmdb || tvdb || imdb) ? 'sonarr' : null;
        return null;
    }

    /**
     * The add scope implied by a placeholder's kind (candidates without a kind: movie / whole series).
     * @param {object} item
     * @returns {{scope: string, seasonNumber?: number, episodes?: Array<{s: number, e: number}>}|null}
     */
    function scopeOf(item) {
        const service = serviceFor(item);
        if (!service) return null;
        if (service === 'radarr') return { scope: 'movie' };
        const season = Number(item.seasonNumber);
        if (item.kind === 'season' && Number.isInteger(season) && season >= 0) {
            return { scope: 'season', seasonNumber: season };
        }
        if (item.kind === 'episodes' && Number.isInteger(season) && season >= 0 && Array.isArray(item.episodes) && item.episodes.length > 0) {
            const episodes = item.episodes
                .map((ep) => ({ s: Number(ep?.s), e: Number(ep?.e) }))
                .filter((ep) => ep.s === season && Number.isInteger(ep.e) && ep.e >= 0);
            if (episodes.length === 0) return null;
            return { scope: 'episodes', seasonNumber: season, episodes };
        }
        return { scope: 'series' };
    }

    /**
     * "S01E03, S01E05" for a list of episodes.
     * @param {Array<{s: number, e: number}>} episodes
     * @returns {string}
     */
    function formatEpisodes(episodes) {
        const pad = (n) => String(n).padStart(2, '0');
        return (episodes || []).map((ep) => `S${pad(ep.s)}E${pad(ep.e)}`).join(', ');
    }

    /**
     * Localised one-line description of what the add will do.
     * @param {object} item
     * @returns {string} Plain text (escape before inserting as HTML).
     */
    function describeScope(item) {
        const scope = scopeOf(item);
        if (!scope) return '';
        switch (scope.scope) {
            case 'movie': return JE.t('listPlaceholders_arr_scope_movie');
            case 'season': return JE.t('listPlaceholders_arr_scope_season', { season: scope.seasonNumber });
            case 'episodes': return JE.t('listPlaceholders_arr_scope_episodes', { episodes: formatEpisodes(scope.episodes) });
            default: return JE.t('listPlaceholders_arr_scope_series');
        }
    }

    /**
     * A menu entry for a placeholder's "…" menu, or null when it doesn't apply (not admin, feature off,
     * custom entry, no usable id).
     * @param {object} item - Placeholder.
     * @param {{onDone?: function(object): void}} [options]
     * @returns {{id: string, label: string, icon: string, onSelect: function(): Promise<object|null>}|null}
     */
    function menuItemFor(item, options = {}) {
        if (!isAvailable()) return null;
        const service = serviceFor(item);
        if (!service) return null;
        return {
            id: 'arr-add',
            label: JE.t(service === 'radarr' ? 'listPlaceholders_arr_menu_radarr' : 'listPlaceholders_arr_menu_sonarr'),
            icon: 'add_to_queue',
            onSelect: () => openAddDialog(item, options)
        };
    }

    /**
     * A ready-made button ("Add to Radarr/Sonarr") that opens the dialog; null when not applicable.
     * @param {object} item - Placeholder or candidate.
     * @param {{className?: string, onDone?: function(object): void}} [options]
     * @returns {HTMLButtonElement|null}
     */
    function createAddButton(item, options = {}) {
        const entry = menuItemFor(item, options);
        if (!entry) return null;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `je-lp-arr-add-button ${options.className || ''}`.trim();
        button.textContent = entry.label;
        button.setAttribute('aria-label', entry.label);
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            entry.onSelect();
        });
        return button;
    }

    // ── Server calls ──────────────────────────────────────────────────────

    /**
     * Whether an options response is worth reusing: every instance answered (no per-instance `error`). A failed
     * instance (stopped, wrong key, timed out) must be asked again on the next dialog, not for a minute later.
     * @param {any} data
     * @returns {boolean}
     */
    function cacheableOptions(data) {
        const instances = [...(Array.isArray(data?.radarr) ? data.radarr : []), ...(Array.isArray(data?.sonarr) ? data.sonarr : [])];
        return !!data && !instances.some((instance) => instance?.error);
    }

    /**
     * Forgets the cached options, so the next dialog reads the instances, profiles and folders again.
     */
    function invalidateOptions() {
        optionsCache = {};
    }

    /**
     * Quality profiles / root folders of the enabled instances (cached for a minute per type). Pass `type` so that
     * a slow or unreachable Sonarr never holds up a Radarr dialog (and the other way round).
     * @param {{type?: 'movie'|'tv', force?: boolean, signal?: AbortSignal}} [options]
     * @returns {Promise<{radarr: Array<object>, sonarr: Array<object>, minimumAvailability: string[], seriesTypes: string[]}>}
     */
    async function getOptions(options = {}) {
        const type = options.type === 'movie' || options.type === 'tv' ? options.type : null;
        const slot = type || 'all';
        const cached = optionsCache[slot];
        if (!options.force && cached && Date.now() - cached.at < OPTIONS_TTL_MS) {
            return cached.data;
        }
        if (!options.force && optionsInFlight[slot]) return optionsInFlight[slot];
        const path = type ? `${API}/options?type=${type}` : `${API}/options`;
        const request = JE.core.api.plugin(path, { skipCache: true, skipRetry: true, signal: options.signal })
            .then((data) => {
                if (cacheableOptions(data)) optionsCache[slot] = { at: Date.now(), data };
                else delete optionsCache[slot];
                return data;
            })
            .finally(() => {
                if (optionsInFlight[slot] === request) delete optionsInFlight[slot];
            });
        optionsInFlight[slot] = request;
        return request;
    }

    /**
     * Radarr (movie) / Sonarr (tv) lookup. Terms: `tmdb:123`, `tvdb:123` (tv), `imdb:tt123`, or text.
     * @param {string} term
     * @param {'movie'|'tv'} type
     * @param {{signal?: AbortSignal, instance?: number}} [options]
     * @returns {Promise<{instance: object, results: Array<object>}>}
     */
    function lookup(term, type, options = {}) {
        const params = new URLSearchParams({ type: type === 'tv' ? 'tv' : 'movie', term: String(term ?? '') });
        if (Number.isInteger(options.instance) && options.instance > 0) params.set('instance', String(options.instance));
        return JE.core.api.plugin(`${API}/lookup?${params.toString()}`, { skipCache: true, skipRetry: true, signal: options.signal });
    }

    /**
     * Admin "Add title" helper: Radarr and Sonarr text lookups side by side, merged as candidates tagged
     * `source:'arr'`. A service that isn't configured (or fails) just contributes nothing.
     * @param {string} query
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<Array<object>>} Candidates (each with `instance` = the answering instance).
     */
    async function searchCandidates(query, options = {}) {
        const text = String(query ?? '').trim();
        if (!isAvailable() || text.length === 0) return [];
        const settled = await Promise.allSettled([
            lookup(text, 'movie', options),
            lookup(text, 'tv', options)
        ]);
        const candidates = [];
        for (const outcome of settled) {
            if (outcome.status !== 'fulfilled') {
                if (outcome.reason?.name === 'AbortError') throw outcome.reason;
                continue;
            }
            const data = outcome.value || {};
            for (const result of data.results || []) {
                candidates.push({ ...result, source: 'arr', instance: data.instance });
            }
        }
        return candidates;
    }

    /**
     * Turns an arr candidate into a new-placeholder body (movie / whole series). Null when it has no TMDB id,
     * which every non-custom placeholder needs.
     * @param {object} candidate
     * @returns {object|null}
     */
    function toPlaceholder(candidate) {
        if (!candidate || !(Number(candidate.tmdbId) > 0) || !candidate.title) return null;
        const tv = candidate.mediaType === 'tv';
        /** @type {Record<string, any>} */
        const placeholder = {
            kind: tv ? 'series' : 'movie',
            mediaType: tv ? 'tv' : 'movie',
            tmdbId: Number(candidate.tmdbId),
            title: String(candidate.title)
        };
        if (tv && Number(candidate.tvdbId) > 0) placeholder.tvdbId = Number(candidate.tvdbId);
        if (candidate.imdbId) placeholder.imdbId = candidate.imdbId;
        if (candidate.year) placeholder.year = candidate.year;
        if (candidate.releaseDate) placeholder.releaseDate = candidate.releaseDate;
        if (candidate.posterPath) placeholder.posterPath = candidate.posterPath;
        if (candidate.overview) placeholder.overview = candidate.overview;
        return placeholder;
    }

    /**
     * New client request id (replayed by the server for 10 minutes on retries).
     * @returns {string}
     */
    function newRequestId() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        return `lp-arr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    /**
     * Builds the POST /arr/add body from a placeholder/candidate and the dialog choices.
     * @param {object} item
     * @param {{instance: number, instanceName?: string, instanceKey?: string, qualityProfileId: number, rootFolderPath: string, search?: boolean, minimumAvailability?: string, seriesType?: string}} choices
     * @param {string} [requestId]
     * @returns {object|null} Null when the item can't be added.
     */
    function buildAddBody(item, choices, requestId) {
        const service = serviceFor(item);
        const scope = scopeOf(item);
        if (!service || !scope) return null;
        /** @type {Record<string, any>} */
        const body = {
            requestId: requestId || newRequestId(),
            mediaType: service === 'radarr' ? 'movie' : 'tv',
            instance: Number(choices.instance) || 0,
            qualityProfileId: Number(choices.qualityProfileId),
            rootFolderPath: String(choices.rootFolderPath || ''),
            scope: scope.scope,
            search: choices.search === true
        };
        if (choices.instanceName) body.instanceName = choices.instanceName;
        if (typeof choices.instanceKey === 'string' && /^[0-9a-f]{16}$/.test(choices.instanceKey)) body.instanceKey = choices.instanceKey;
        if (Number(item.tmdbId) > 0) body.tmdbId = Number(item.tmdbId);
        if (service === 'sonarr' && Number(item.tvdbId) > 0) body.tvdbId = Number(item.tvdbId);
        if (typeof item.imdbId === 'string' && /^tt\d{5,10}$/i.test(item.imdbId)) body.imdbId = item.imdbId.toLowerCase();
        if (scope.seasonNumber !== undefined) body.seasonNumber = scope.seasonNumber;
        if (scope.episodes) body.episodes = scope.episodes;
        if (service === 'radarr') {
            body.minimumAvailability = AVAILABILITIES.includes(choices.minimumAvailability) ? choices.minimumAvailability : 'released';
        } else if (SERIES_TYPES.includes(choices.seriesType)) {
            body.seriesType = choices.seriesType;
        }
        return body;
    }

    /**
     * POST /arr/add.
     * @param {object} body - From buildAddBody().
     * @returns {Promise<object>} ArrAddResult.
     */
    function add(body) {
        return JE.core.api.plugin(`${API}/add`, { method: 'POST', body, skipCache: true, skipRetry: true, timeoutMs: 120000 });
    }

    // ── Remembered choices (per user, per instance) ───────────────────────

    /**
     * @returns {Record<string, any>}
     */
    function readChoices() {
        try {
            const key = JE.session?.userScopedKey ? JE.session.userScopedKey(CHOICE_KEY) : CHOICE_KEY;
            const parsed = JSON.parse(localStorage.getItem(key) || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    /**
     * @param {Record<string, any>} choices
     */
    function writeChoices(choices) {
        try {
            const key = JE.session?.userScopedKey ? JE.session.userScopedKey(CHOICE_KEY) : CHOICE_KEY;
            localStorage.setItem(key, JSON.stringify(choices));
        } catch {
            // Private mode / quota: remembering is a convenience only.
        }
    }

    /**
     * Storage identity of an instance from GET /arr/options: its server key (a hash of the URL, unique even when
     * names repeat, e.g. two blank names both shown as "Radarr"), else id + name.
     * @param {{id?: number, name?: string, key?: string}} instance
     * @returns {string}
     */
    function instanceIdentity(instance) {
        if (typeof instance?.key === 'string' && instance.key) return instance.key;
        return `${instance?.id ?? ''}|${instance?.name ?? ''}`;
    }

    /**
     * The remembered choice for one instance, or (without an instance) which instance was used last per service.
     * @param {'radarr'|'sonarr'} service
     * @param {{id?: number, name?: string, key?: string}} [instance]
     * @returns {object|null} Choice, or `{identity}` for the last-used marker.
     */
    function loadChoice(service, instance) {
        const all = readChoices();
        if (instance === undefined) return all[`${service}:last`] || null;
        return all[`${service}|${instanceIdentity(instance)}`] || null;
    }

    /**
     * Remembers the choices made for an instance (and that it was used last).
     * @param {'radarr'|'sonarr'} service
     * @param {{id?: number, name?: string, key?: string}} instance
     * @param {object} choice
     */
    function saveChoice(service, instance, choice) {
        const all = readChoices();
        const identity = instanceIdentity(instance);
        all[`${service}|${identity}`] = {
            qualityProfileId: choice.qualityProfileId,
            rootFolderPath: choice.rootFolderPath,
            minimumAvailability: choice.minimumAvailability,
            seriesType: choice.seriesType,
            search: choice.search === true
        };
        all[`${service}:last`] = { identity };
        writeChoices(all);
    }

    // ── Messages ──────────────────────────────────────────────────────────

    /**
     * Rewrites an instance URL for the address Jellyfin is opened at (same rules as arr-links.js).
     * @param {string} instanceUrl
     * @param {string} urlMappings - "jellyfin_url|arr_url" lines.
     * @returns {string|null}
     */
    function mappedInstanceUrl(instanceUrl, urlMappings) {
        if (!instanceUrl) return null;
        const current = ((typeof ApiClient !== 'undefined' && ApiClient.serverAddress) ? ApiClient.serverAddress() : window.location.origin)
            .replace(/\/+$/, '').toLowerCase();
        for (const line of String(urlMappings || '').split('\n')) {
            const parts = line.trim().split('|').map((p) => p.trim());
            if (parts.length === 2 && parts[0] && parts[1] && parts[0].replace(/\/+$/, '').toLowerCase() === current) {
                return parts[1].replace(/\/+$/, '');
            }
        }
        return instanceUrl.replace(/\/+$/, '');
    }

    /**
     * Link to the title's page in the arr UI, or null.
     * @param {object} result - ArrAddResult.
     * @returns {string|null}
     */
    function arrLink(result) {
        if (!result?.arrPath || !result.instance) return null;
        const base = mappedInstanceUrl(result.instance.instanceUrl, result.instance.urlMappings);
        if (!base || !/^https?:\/\//i.test(base)) return null;
        return base + result.arrPath;
    }

    /**
     * Toast HTML for a successful add.
     * @param {object} result - ArrAddResult.
     * @returns {string}
     */
    function resultMessage(result) {
        const params = { title: esc(result?.title), instance: esc(result?.instance?.name) };
        let key;
        switch (result?.result) {
            case 'added': key = result.searched ? 'listPlaceholders_arr_result_added_search' : 'listPlaceholders_arr_result_added'; break;
            case 'monitoring_added': key = result.searched ? 'listPlaceholders_arr_result_monitoring_added_search' : 'listPlaceholders_arr_result_monitoring_added'; break;
            case 'already_monitored': key = 'listPlaceholders_arr_result_already_monitored'; break;
            default: key = 'listPlaceholders_arr_result_already_exists';
        }
        let html = JE.t(key, params);
        if (Array.isArray(result?.missingEpisodes) && result.missingEpisodes.length > 0) {
            html += `<br>${JE.t('listPlaceholders_arr_result_missing_episodes', { instance: params.instance, episodes: esc(formatEpisodes(result.missingEpisodes)) })}`;
        }
        if (result?.searchFailed === true) {
            html += `<br>${JE.t('listPlaceholders_arr_result_search_failed', { instance: params.instance })}`;
        }
        const link = arrLink(result);
        if (link) {
            html += `<br><a class="je-lp-arr-open" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${JE.t('listPlaceholders_arr_open', params)}</a>`;
        }
        return html;
    }

    /**
     * Localised, escaped text for a failed call.
     * @param {*} error - Error thrown by JE.core.api (status, responseJSON).
     * @param {'radarr'|'sonarr'} service
     * @returns {string}
     */
    function errorMessage(error, service) {
        const code = error?.responseJSON?.code;
        const serviceName = service === 'sonarr' ? 'Sonarr' : 'Radarr';
        const known = {
            not_configured: 'listPlaceholders_arr_error_not_configured',
            forbidden: 'listPlaceholders_arr_error_forbidden',
            arr_unreachable: 'listPlaceholders_arr_error_unreachable',
            arr_timeout: 'listPlaceholders_arr_error_timeout',
            arr_auth_failed: 'listPlaceholders_arr_error_auth',
            arr_redirect: 'listPlaceholders_arr_error_redirect',
            invalid_quality_profile: 'listPlaceholders_arr_error_profile',
            invalid_root_folder: 'listPlaceholders_arr_error_root',
            not_found: 'listPlaceholders_arr_error_not_found',
            instance_changed: 'listPlaceholders_arr_error_instance_changed'
        };
        if (known[code]) return JE.t(known[code], { service: serviceName });
        if (error?.status === 404 && error?.responseJSON?.message === 'disabled') return JE.t('listPlaceholders_arr_error_forbidden', { service: serviceName });
        if (typeof error?.responseJSON?.message === 'string' && error.responseJSON.message) return esc(error.responseJSON.message);
        return JE.t('listPlaceholders_arr_error_generic', { service: serviceName });
    }

    // ── Dialog ────────────────────────────────────────────────────────────

    /**
     * Injects the dialog's few extra rules once (the rest comes from the Seerr modal styles).
     */
    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const css = `
            .je-lp-arr-scope { display: flex; gap: 10px; align-items: flex-start; margin: 0 0 1.1em; padding: 10px 12px; border-radius: 8px; background: rgba(79, 70, 229, 0.14); border: 1px solid rgba(129, 140, 248, 0.3); color: #e2e8f0; line-height: 1.4; }
            .je-lp-arr-scope .material-icons { font-size: 20px; color: #a5b4fc; }
            .je-lp-arr-state { margin: -0.4em 0 1.1em; color: #cbd5e1; font-size: 0.9rem; }
            .je-lp-arr-state:empty { display: none; }
            .je-lp-arr-dialog .jellyseerr-advanced-options { margin-top: 0; padding-top: 0; border-top: 0; }
            .je-lp-arr-check { display: flex; align-items: center; gap: 10px; margin-top: 0.4em; color: #e2e8f0; cursor: pointer; }
            .je-lp-arr-check input { width: 18px; height: 18px; accent-color: #6366f1; }
            .je-lp-arr-message { margin-top: 1em; padding: 10px 12px; border-radius: 8px; background: rgba(220, 38, 38, 0.15); border: 1px solid rgba(248, 113, 113, 0.35); color: #fecaca; }
            .je-lp-arr-message:empty { display: none; }
            .je-lp-arr-add-button { cursor: pointer; }
            .jellyfin-enhanced-toast a.je-lp-arr-open { color: inherit; text-decoration: underline; }
        `;
        if (JE.core?.ui?.injectCss) {
            JE.core.ui.injectCss(STYLE_ID, css);
        } else {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = css;
            document.head.appendChild(style);
        }
    }

    /**
     * @param {string} label
     * @returns {string}
     */
    function loadingOption(label) {
        return `<option value="">${esc(label)}</option>`;
    }

    /**
     * The dialog body markup (selects are filled once the options arrive).
     * @param {'radarr'|'sonarr'} service
     * @param {object} item
     * @returns {string}
     */
    function dialogBody(service, item) {
        const loading = loadingOption(JE.t('listPlaceholders_arr_loading'));
        const extra = service === 'radarr'
            ? `<div class="jellyseerr-form-group">
                    <label for="je-lp-arr-availability">${esc(JE.t('listPlaceholders_arr_availability'))}</label>
                    <select is="emby-select" id="je-lp-arr-availability" class="emby-select">${AVAILABILITIES.map((a) => `<option value="${a}"${a === 'released' ? ' selected' : ''}>${esc(JE.t(`listPlaceholders_arr_availability_${a}`))}</option>`).join('')}</select>
               </div>`
            : `<div class="jellyseerr-form-group">
                    <label for="je-lp-arr-series-type">${esc(JE.t('listPlaceholders_arr_series_type'))}</label>
                    <select is="emby-select" id="je-lp-arr-series-type" class="emby-select"><option value="">${esc(JE.t('listPlaceholders_arr_series_type_auto'))}</option>${SERIES_TYPES.map((t) => `<option value="${t}">${esc(JE.t(`listPlaceholders_arr_series_type_${t}`))}</option>`).join('')}</select>
               </div>`;
        return `
            <div class="je-lp-arr-dialog" data-service="${service}">
                <div class="je-lp-arr-scope"><span class="material-icons" aria-hidden="true">info</span><span class="je-lp-arr-scope-text">${esc(describeScope(item))}</span></div>
                <div class="je-lp-arr-state" role="status" aria-live="polite"></div>
                <div class="jellyseerr-advanced-options">
                    <div class="jellyseerr-form-row">
                        <div class="jellyseerr-form-group">
                            <label for="je-lp-arr-instance">${esc(JE.t('listPlaceholders_arr_instance'))}</label>
                            <select is="emby-select" id="je-lp-arr-instance" class="emby-select">${loading}</select>
                        </div>
                        ${extra}
                    </div>
                    <div class="jellyseerr-form-row">
                        <div class="jellyseerr-form-group">
                            <label for="je-lp-arr-quality">${esc(JE.t('listPlaceholders_arr_quality'))}</label>
                            <select is="emby-select" id="je-lp-arr-quality" class="emby-select">${loading}</select>
                        </div>
                        <div class="jellyseerr-form-group">
                            <label for="je-lp-arr-root">${esc(JE.t('listPlaceholders_arr_root'))}</label>
                            <select is="emby-select" id="je-lp-arr-root" class="emby-select">${loading}</select>
                        </div>
                    </div>
                    <label class="je-lp-arr-check"><input type="checkbox" id="je-lp-arr-search"><span>${esc(JE.t('listPlaceholders_arr_search'))}</span></label>
                </div>
                <div class="je-lp-arr-message" role="alert"></div>
            </div>`;
    }

    /**
     * Formats a byte count ("1.3 TB").
     * @param {number} bytes
     * @returns {string}
     */
    function formatBytes(bytes) {
        if (!(bytes > 0)) return '';
        const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
        return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(1))} ${units[i]}`;
    }

    /**
     * Fills a select with options and picks `selected` when present, else the first.
     * @param {HTMLSelectElement} select
     * @param {Array<{value: string, label: string}>} entries
     * @param {string|number|undefined|null} selected
     */
    function fillSelect(select, entries, selected) {
        select.innerHTML = entries.map((e) => `<option value="${esc(e.value)}">${esc(e.label)}</option>`).join('');
        const wanted = selected == null ? null : String(selected);
        if (wanted !== null && entries.some((e) => e.value === wanted)) select.value = wanted;
        else if (entries.length > 0) select.value = entries[0].value;
    }

    /**
     * Opens the add dialog for a placeholder or candidate. Resolves with the server result after a successful
     * add (also shown as a toast), or null when the dialog is closed without adding.
     * @param {object} item - Placeholder (kind…) or candidate (mediaType + ids).
     * @param {{onDone?: function(object): void}} [options]
     * @returns {Promise<object|null>}
     */
    function openAddDialog(item, options = {}) {
        const service = serviceFor(item);
        if (!isAvailable() || !service || !JE.jellyseerrModal?.create) return Promise.resolve(null);
        ensureStyles();

        return new Promise((resolve) => {
            let settled = false;
            // Closed by Cancel / Escape / backdrop / browser back (its history entry is already gone then).
            let closed = false;
            // An add is in flight: no second submit, no picker changes until it has failed.
            let adding = false;
            let currentOptions = null;
            let lookupToken = 0;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            const title = String(item.title || '');
            const subtitle = item.year ? `${title} (${item.year})` : title;
            // One id per distinct add: if a response got lost, retrying the same choices replays the server's first
            // result instead of adding twice (failures aren't replayed, so a corrected retry runs again). Other
            // choices (instance, profile, folder...) get their own id, so they never get another add's result.
            const requestIds = new Map();
            const backdropPath = typeof item.backdropPath === 'string' && /^\/[A-Za-z0-9_-]+\.(jpg|png)$/.test(item.backdropPath) ? item.backdropPath : undefined;

            const { modalElement, show } = JE.jellyseerrModal.create({
                title: JE.t(service === 'radarr' ? 'listPlaceholders_arr_dialog_title_radarr' : 'listPlaceholders_arr_dialog_title_sonarr'),
                subtitle,
                bodyHtml: dialogBody(service, item),
                backdropPath,
                buttonText: JE.t(service === 'radarr' ? 'listPlaceholders_arr_menu_radarr' : 'listPlaceholders_arr_menu_sonarr'),
                onClose: () => {
                    closed = true;
                    finish(null);
                },
                onSave: async (modalEl, button) => {
                    if (adding) return;
                    const choices = readDialogChoices(modalEl);
                    const messageEl = modalEl.querySelector('.je-lp-arr-message');
                    if (!choices) {
                        messageEl.textContent = JE.t('listPlaceholders_arr_error_choose');
                        return;
                    }
                    const body = buildAddBody(item, choices);
                    if (!body) return;
                    const asked = { ...body };
                    delete asked.requestId;
                    const fingerprint = JSON.stringify(asked);
                    if (!requestIds.has(fingerprint)) requestIds.set(fingerprint, body.requestId);
                    body.requestId = requestIds.get(fingerprint);
                    const label = button.textContent;
                    setAdding(true);
                    button.textContent = JE.t('listPlaceholders_arr_adding');
                    messageEl.textContent = '';
                    // An add can take a while: if another user signed in meanwhile, its result (toast with the
                    // arr link, remembered choices, callbacks, navigation) is not theirs to see.
                    const epoch = epochNow();
                    try {
                        const result = await add(body);
                        if (!isCurrentEpoch(epoch)) {
                            finish(null);
                            return;
                        }
                        saveChoice(service, choices.instanceRef, choices);
                        JE.toast(resultMessage(result), RESULT_TOAST_MS);
                        if (typeof options.onDone === 'function') {
                            try { options.onDone(result); } catch (err) { console.warn(`${logPrefix} onDone failed:`, err); }
                        }
                        finish(result);
                        // Same exit path as Cancel: modal.js closes on popstate, which also drops its history entry.
                        // A dialog the admin already closed has no entry left: going back would leave their page.
                        if (!closed) history.back();
                    } catch (error) {
                        if (!isCurrentEpoch(epoch)) {
                            finish(null);
                            return;
                        }
                        console.warn(`${logPrefix} add failed:`, error?.status, error?.responseJSON?.code);
                        // The instances, profiles or folders this dialog offered are out of date (or the arr is
                        // down): the next dialog must read them again instead of offering the same stale choices.
                        if (STALE_OPTION_CODES.has(error?.responseJSON?.code)) invalidateOptions();
                        messageEl.innerHTML = errorMessage(error, service);
                        // Closed while adding: the dialog's message line is gone, so the failure shows as a toast.
                        if (closed) JE.toast(errorMessage(error, service), RESULT_TOAST_MS);
                        button.textContent = label;
                        setAdding(false);
                    }
                }
            });

            const instanceSelect = /** @type {HTMLSelectElement} */ (modalElement.querySelector('#je-lp-arr-instance'));
            const qualitySelect = /** @type {HTMLSelectElement} */ (modalElement.querySelector('#je-lp-arr-quality'));
            const rootSelect = /** @type {HTMLSelectElement} */ (modalElement.querySelector('#je-lp-arr-root'));
            const searchBox = /** @type {HTMLInputElement} */ (modalElement.querySelector('#je-lp-arr-search'));
            const stateEl = modalElement.querySelector('.je-lp-arr-state');
            const messageEl = modalElement.querySelector('.je-lp-arr-message');
            const primary = /** @type {HTMLButtonElement} */ (modalElement.querySelector('.jellyseerr-modal-button-primary'));
            primary.disabled = true;

            /**
             * Enables the add button only when the choices are complete and no add is running.
             */
            function refreshPrimary() {
                primary.disabled = adding || !readDialogChoices(modalElement);
            }

            /**
             * Locks (or unlocks) the button and every picker while an add is in flight.
             * @param {boolean} busy
             */
            function setAdding(busy) {
                adding = busy;
                const instanceCount = (currentOptions?.[service] || []).length;
                instanceSelect.disabled = busy || instanceCount < 2;
                [qualitySelect, rootSelect, searchBox,
                    modalElement.querySelector('#je-lp-arr-availability'),
                    modalElement.querySelector('#je-lp-arr-series-type')].forEach((el) => {
                    if (el) el.disabled = busy;
                });
                refreshPrimary();
            }

            /**
             * Reads the current choices; null when something required is missing.
             * @param {Element} root
             * @returns {object|null}
             */
            function readDialogChoices(root) {
                const instances = currentOptions?.[service] || [];
                const instance = instances.find((i) => String(i.id) === instanceSelect.value);
                const qualityProfileId = Number(qualitySelect.value);
                const rootFolderPath = rootSelect.value;
                if (!instance || instance.error || !(qualityProfileId > 0) || !rootFolderPath) return null;
                return {
                    instance: instance.id,
                    instanceName: instance.name,
                    instanceKey: instance.key,
                    instanceRef: instance,
                    qualityProfileId,
                    rootFolderPath,
                    search: searchBox.checked,
                    minimumAvailability: root.querySelector('#je-lp-arr-availability')?.value,
                    seriesType: root.querySelector('#je-lp-arr-series-type')?.value || undefined
                };
            }

            /**
             * Shows the selected instance's pickers (restoring what was used with it last time).
             */
            function applyInstance() {
                const instances = currentOptions?.[service] || [];
                const instance = instances.find((i) => String(i.id) === instanceSelect.value);
                messageEl.textContent = '';
                if (!instance) return;
                if (instance.error) {
                    fillSelect(qualitySelect, [], null);
                    fillSelect(rootSelect, [], null);
                    messageEl.innerHTML = errorMessage({ responseJSON: { code: instance.error, message: instance.message } }, service);
                    primary.disabled = true;
                    stateEl.textContent = '';
                    return;
                }
                const remembered = loadChoice(service, instance) || {};
                fillSelect(qualitySelect, (instance.qualityProfiles || []).map((p) => ({ value: String(p.id), label: p.name })), remembered.qualityProfileId);
                fillSelect(rootSelect, (instance.rootFolders || []).map((f) => ({
                    value: f.path,
                    label: f.freeSpace ? `${f.path} (${formatBytes(f.freeSpace)})` : f.path
                })), remembered.rootFolderPath);
                const availability = modalElement.querySelector('#je-lp-arr-availability');
                if (availability) availability.value = AVAILABILITIES.includes(remembered.minimumAvailability) ? remembered.minimumAvailability : 'released';
                const seriesType = modalElement.querySelector('#je-lp-arr-series-type');
                if (seriesType) seriesType.value = SERIES_TYPES.includes(remembered.seriesType) ? remembered.seriesType : '';
                searchBox.checked = remembered.search === true;
                refreshPrimary();
                showArrState(instance);
            }

            /**
             * Looks the title up in the chosen instance to say upfront whether it is already there.
             * @param {object} instance
             */
            async function showArrState(instance) {
                const token = ++lookupToken;
                stateEl.textContent = '';
                const term = Number(item.tvdbId) > 0 && service === 'sonarr' ? `tvdb:${item.tvdbId}`
                    : Number(item.tmdbId) > 0 ? `tmdb:${item.tmdbId}` : item.imdbId ? `imdb:${item.imdbId}` : null;
                if (!term) return;
                try {
                    const data = await lookup(term, service === 'radarr' ? 'movie' : 'tv', { instance: instance.id });
                    if (token !== lookupToken || settled) return;
                    const hit = (data?.results || [])[0];
                    if (!hit) {
                        stateEl.textContent = JE.t('listPlaceholders_arr_state_not_found', { instance: instance.name });
                    } else if (hit.inArr) {
                        const scope = scopeOf(item)?.scope;
                        stateEl.textContent = JE.t(scope === 'season' || scope === 'episodes'
                            ? 'listPlaceholders_arr_state_in_arr_monitor'
                            : 'listPlaceholders_arr_state_in_arr', { instance: instance.name });
                    }
                } catch {
                    // The add itself reports any real problem.
                }
            }

            instanceSelect.addEventListener('change', () => {
                if (!adding) applyInstance();
            });
            [qualitySelect, rootSelect].forEach((el) => el.addEventListener('change', refreshPrimary));

            show();

            getOptions({ type: service === 'radarr' ? 'movie' : 'tv' }).then((data) => {
                if (settled) return;
                currentOptions = data || {};
                const instances = currentOptions[service] || [];
                if (instances.length === 0) {
                    fillSelect(instanceSelect, [], null);
                    fillSelect(qualitySelect, [], null);
                    fillSelect(rootSelect, [], null);
                    messageEl.innerHTML = errorMessage({ responseJSON: { code: 'not_configured' } }, service);
                    return;
                }
                const last = loadChoice(service)?.identity;
                const preferred = instances.find((i) => instanceIdentity(i) === last && !i.error) || instances.find((i) => !i.error) || instances[0];
                fillSelect(instanceSelect, instances.map((i) => ({ value: String(i.id), label: i.name })), String(preferred.id));
                instanceSelect.disabled = instances.length < 2;
                applyInstance();
            }).catch((error) => {
                if (settled) return;
                messageEl.innerHTML = errorMessage(error, service);
            });
        });
    }

    JE.listPlaceholders = JE.listPlaceholders || {};
    JE.listPlaceholders.arr = {
        isAvailable,
        serviceFor,
        scopeOf,
        describeScope,
        formatEpisodes,
        menuItemFor,
        createAddButton,
        getOptions,
        lookup,
        searchCandidates,
        toPlaceholder,
        buildAddBody,
        add,
        loadChoice,
        saveChoice,
        arrLink,
        resultMessage,
        errorMessage,
        openAddDialog
    };
})(window.JellyfinEnhanced);
