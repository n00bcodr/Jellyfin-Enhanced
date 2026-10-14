/**
 * @file Requests & downloads, phase 3: asking for titles from the client. One place that talks to
 * the request API (POST /JellyfinEnhanced/acquire/requests, its cancel route, GET .../me and
 * .../quota), keeps a retry-safe clientRequestId per tap (a retry after a lost answer reuses it, so
 * the server never records the same ask twice), turns every answer into honest family words (request
 * outcomes: waiting for an OK, asked, already asked by someone, quota, blocked, couldn't ask) and
 * tells the surfaces showing the title to refresh (JE.arrStatus.refresh and JE.arrAsk.onChange).
 * Also an administrator's Search for a title missing for a long while (searchInstance, adminSearch:
 * the arr's own search through the Manage drawer's audited route; everyone else asks instead).
 * Exposes JE.arrAsk; the request controls (season rows, request sheet, smart actions, hub tabs) all
 * build on it. Everything is off unless the server's ArrRequestsEnabled flag is on.
 */
(function (JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Ask:';
    /** How long the caller's capabilities are reused before asking the server again. */
    const ME_TTL_MS = 60000;
    /** Reasons of an accepted ask that mean "waits for an OK". */
    const WAITING = new Set(['awaiting_approval', 'over_quota', 'seerr_whole_series_only', 'authorization_changed', 'identity_changed', 'configuration_changed']);

    let meState = null; // { at, epoch, promise, value }
    /** @type {Map<string, string>} input fingerprint -> clientRequestId kept until a definitive answer */
    const openIds = new Map();
    /** @type {Set<Function>} */
    const listeners = new Set();

    /**
     * Translates through the shared status helper (keeps {param} substitution consistent).
     * @param {string} key en.json key.
     * @param {Object} [params] Parameters.
     * @returns {string} Text.
     */
    function tr(key, params) {
        return JE.arrStatus ? JE.arrStatus.tr(key, params) : key;
    }

    /**
     * True when the server has the request controls on (phase 3 with a request backend) and the
     * status module is running (the controls live on its surfaces).
     * @returns {boolean} Enabled.
     */
    function enabled() {
        return JE.pluginConfig?.ArrRequestsEnabled === true && JE.arrStatus?.enabled?.() === true;
    }

    /**
     * The current session epoch (a user switch changes it).
     * @returns {number} Epoch.
     */
    function epoch() {
        return JE.session?.getEpoch ? JE.session.getEpoch() : 0;
    }

    /**
     * A request to a plugin route; resolves with {status, body} for every HTTP answer (errors
     * included, so the request outcome's real HTTP status is kept) and rejects only when no answer
     * arrived (network failure, abort).
     * @param {string} path Path under /JellyfinEnhanced.
     * @param {{method?: string, body?: Object, signal?: AbortSignal}} [options] Options.
     * @returns {Promise<{status: number, body: Object|null}>} The answer.
     */
    async function call(path, options) {
        const method = options?.method || 'GET';
        const headers = { 'Authorization': `MediaBrowser Token="${ApiClient.accessToken()}"`, 'Accept': 'application/json' };
        if (options?.body) headers['Content-Type'] = 'application/json';
        const response = await fetch(ApiClient.getUrl(`/JellyfinEnhanced${path}`), {
            method,
            headers,
            body: options?.body ? JSON.stringify(options.body) : undefined,
            signal: options?.signal,
            cache: 'no-store'
        });
        let body = null;
        try {
            const text = await response.text();
            body = text ? JSON.parse(text) : null;
        } catch {
            body = null;
        }
        return { status: response.status, body };
    }

    /**
     * The caller's own request capabilities ({role, canRequest, canApprove, asksFirst, can4kMovies,
     * can4kSeries, backend, contact, freeEpisodes}), cached for a minute per user; null when the
     * feature is off or the server can't say.
     * @param {boolean} [force] Ask the server again.
     * @returns {Promise<Object|null>} Capabilities.
     */
    function me(force) {
        if (!enabled()) return Promise.resolve(null);
        const now = Date.now();
        const current = epoch();
        if (!force && meState && meState.epoch === current && (meState.promise || now - meState.at < ME_TTL_MS)) {
            return meState.promise || Promise.resolve(meState.value);
        }
        const state = { at: now, epoch: current, promise: null, value: null };
        meState = state;
        state.promise = call('/acquire/requests/me').then((answer) => {
            const value = answer.status === 200 && answer.body?.me ? answer.body.me : null;
            if (meState === state) {
                state.value = value;
                state.at = Date.now();
                state.promise = null;
            }
            return value;
        }).catch((err) => {
            console.warn(`${logPrefix} capabilities unavailable (${err?.message || err})`);
            if (meState === state) meState = null;
            return null;
        });
        return state.promise;
    }

    /**
     * The household contact word for texts ("Dad"), or the neutral word.
     * @param {Object|null} [caps] Capabilities from {@link me}.
     * @returns {string} Contact.
     */
    function contact(caps) {
        return (caps?.contact || '').trim() || tr('arr_contact_default');
    }

    /**
     * The canonical fingerprint of an ask (same scope = same fingerprint, whatever the order).
     * @param {Object} input Mutation input ({key, scope, variant, seasons, episodes}).
     * @returns {string} Fingerprint.
     */
    function fingerprint(input) {
        const seasons = [...new Set(input?.seasons || [])].sort((a, b) => a - b);
        const episodes = (input?.episodes || []).map(e => `${e.season}x${e.episode}`).sort();
        return [input?.key || '', input?.scope || '', input?.variant || 'standard', seasons.join(','), [...new Set(episodes)].join(',')].join('|');
    }

    /**
     * A new random client request id.
     * @returns {string} Id.
     */
    function newClientId() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    }

    /**
     * Input for a movie.
     * @param {string} key Movie title key (movie:tmdb:603).
     * @param {string} [variant] standard or 4k.
     * @returns {Object} Input.
     */
    function movieInput(key, variant) {
        return { key, scope: 'movie', variant: variant || 'standard', seasons: [], episodes: [] };
    }

    /**
     * Input for whole seasons of a series.
     * @param {string} key Series title key (tv:tvdb:78874).
     * @param {number[]} seasons Season numbers.
     * @param {string} [variant] standard or 4k.
     * @returns {Object} Input.
     */
    function seasonsInput(key, seasons, variant) {
        return { key: seriesKey(key), scope: 'seasons', variant: variant || 'standard', seasons: [...new Set(seasons)].sort((a, b) => a - b), episodes: [] };
    }

    /**
     * Input for single episodes of a series.
     * @param {string} key Series (or season/episode) title key.
     * @param {Array<{season: number, episode: number}>} episodes Episodes.
     * @param {string} [variant] standard or 4k.
     * @returns {Object} Input.
     */
    function episodesInput(key, episodes, variant) {
        return { key: seriesKey(key), scope: 'episodes', variant: variant || 'standard', seasons: [], episodes: episodes.map(e => ({ season: e.season, episode: e.episode })) };
    }

    /**
     * The series key of a series, season or episode key.
     * @param {string} key Title key.
     * @returns {string} Series key.
     */
    function seriesKey(key) {
        return String(key || '').replace(/:s\d+(:e\d+)?$/, '');
    }

    /**
     * Turns an HTTP answer of the create/cancel routes into a result with a family state.
     * @param {number} status HTTP status.
     * @param {Object|null} body Response body ({outcome, reason, certainty, message, requestId}).
     * @returns {{ok: boolean, status: number, state: string, outcome: string, reason: string, certainty: string, requestId: string|null}} Result.
     */
    function interpret(status, body) {
        const outcome = typeof body?.outcome === 'string' ? body.outcome : '';
        const reason = typeof body?.reason === 'string' ? body.reason : '';
        const certainty = typeof body?.certainty === 'string' ? body.certainty : '';
        const requestId = typeof body?.requestId === 'string' ? body.requestId : null;
        let state;
        if (status === 202 || outcome === 'maybe_sent' || certainty === 'Unknown') state = 'unknown';
        else if (status >= 200 && status < 300) {
            if (outcome === 'merged' || outcome === 'already_requested') state = 'merged';
            else if (outcome === 'nothing_to_request' || reason === 'nothing_to_request') state = 'nothing';
            else if (WAITING.has(reason)) state = 'waiting';
            else if (reason === 'declined') state = 'declined';
            else state = 'asked';
        } else if (status === 429) state = 'quota';
        else if (status === 409) state = reason === 'idempotency_conflict' ? 'changed' : 'busy';
        else if (status === 503) state = 'unavailable';
        else if (status === 400) state = 'invalid';
        else if (status === 403 && (outcome === 'blocked' || reason === 'decline_cooldown' || reason === 'not_visible_to_user' || reason === 'low_disk')) state = 'blocked';
        else if (status === 403) state = 'denied';
        else if (status === 404) state = 'gone';
        else state = 'failed';
        return { ok: status >= 200 && status < 300, status, state, outcome, reason, certainty, requestId };
    }

    /**
     * Asks for a title (movie, seasons or episodes). A double tap or a retry of the same ask after a
     * lost answer reuses the same clientRequestId; a definitive answer (any HTTP status but 5xx) ends it.
     * On success the surfaces showing the title refresh.
     * @param {Object} input Mutation input (see movieInput / seasonsInput / episodesInput).
     * @param {{clientRequestId?: string, signal?: AbortSignal}} [options] Options.
     * @returns {Promise<Object>} Result (see {@link interpret}); state 'failed' when no answer came.
     */
    async function ask(input, options) {
        if (!enabled()) return { ok: false, status: 0, state: 'off', outcome: '', reason: 'feature_disabled', certainty: '', requestId: null };
        const print = fingerprint(input);
        const clientRequestId = options?.clientRequestId || openIds.get(print) || newClientId();
        openIds.set(print, clientRequestId);
        const started = epoch();
        let answer;
        try {
            answer = await call('/acquire/requests', { method: 'POST', body: { clientRequestId, input }, signal: options?.signal });
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            console.warn(`${logPrefix} ask failed (${err?.message || err})`);
            return { ok: false, status: 0, state: 'failed', outcome: '', reason: 'network', certainty: '', requestId: null, clientRequestId };
        }
        // A server error may or may not have recorded the ask: keep the id so a retry is the same ask.
        if (answer.status < 500) openIds.delete(print);
        const result = { ...interpret(answer.status, answer.body), clientRequestId };
        if (started !== epoch()) return { ...result, stale: true };
        if (result.ok || result.state === 'unknown') {
            meState = null;
            emit({ type: 'ask', key: input.key, input, result });
        }
        return result;
    }

    /**
     * Cancels the caller's own request that hasn't been sent yet.
     * @param {string} requestId Request id.
     * @returns {Promise<Object>} Result (state 'cancelled' on success).
     */
    async function cancel(requestId) {
        if (!enabled() || !/^[0-9a-f]{32}$/i.test(String(requestId || ''))) return { ok: false, status: 0, state: 'invalid', outcome: '', reason: 'invalid_id', certainty: '', requestId: null };
        let answer;
        try {
            answer = await call(`/acquire/requests/${encodeURIComponent(requestId)}/cancel`, { method: 'POST', body: {} });
        } catch (err) {
            console.warn(`${logPrefix} cancel failed (${err?.message || err})`);
            return { ok: false, status: 0, state: 'failed', outcome: '', reason: 'network', certainty: '', requestId };
        }
        const result = interpret(answer.status, answer.body);
        if (result.ok) {
            result.state = 'cancelled';
            emit({ type: 'cancel', requestId, result });
        }
        return result;
    }

    /**
     * The caller's request allowance ({used, limit, remaining, nextSlotAt, usedGb, available}), or null.
     * @param {'movie'|'tv'} mediaType Kind.
     * @returns {Promise<Object|null>} Quota.
     */
    async function quota(mediaType) {
        if (!enabled()) return null;
        try {
            const answer = await call(`/acquire/requests/quota?mediaType=${mediaType === 'tv' ? 'tv' : 'movie'}`);
            return answer.status === 200 && answer.body?.quota ? answer.body.quota : null;
        } catch {
            return null;
        }
    }

    /**
     * The family words for a result: the short chip ("Waiting for OK", "Asked!") and the toast line.
     * Honest about every outcome: nothing says "asked" unless the server recorded it.
     * @param {Object} result Result of {@link ask}.
     * @param {Object|null} [caps] Capabilities (for the contact word).
     * @param {Object|null} [allowance] Quota (for "next one frees up {day}").
     * @returns {{chip: string, text: string, tone: string}} Words.
     */
    function describe(result, caps, allowance) {
        const who = contact(caps);
        switch (result?.state) {
            case 'waiting':
                return result.reason === 'over_quota'
                    ? { chip: tr('arr_ask_chip_waiting'), text: tr('arr_ask_toast_over_quota', { contact: who }), tone: 'asked' }
                    : { chip: tr('arr_ask_chip_waiting'), text: tr('arr_ask_toast_waiting', { contact: who }), tone: 'asked' };
            case 'asked': return { chip: tr('arr_ask_chip_asked'), text: tr('arr_ask_toast_asked'), tone: 'approved' };
            case 'merged': return { chip: tr('arr_ask_chip_asked'), text: tr('arr_ask_toast_merged'), tone: 'approved' };
            case 'nothing': return { chip: '', text: tr('arr_ask_toast_nothing'), tone: 'none' };
            case 'unknown': return { chip: tr('arr_ask_chip_asked'), text: tr('arr_ask_toast_unknown'), tone: 'approved' };
            case 'quota': {
                const day = allowance?.nextSlotAt && JE.arrStatus ? JE.arrStatus.formatDate(allowance.nextSlotAt) : '';
                return { chip: '', text: day ? tr('arr_ask_toast_quota_day', { day }) : tr('arr_ask_toast_quota'), tone: 'attention' };
            }
            case 'blocked':
                return { chip: '', text: result.reason === 'decline_cooldown' ? tr('arr_ask_toast_cooldown', { contact: who }) : tr('arr_ask_toast_blocked'), tone: 'attention' };
            case 'denied': return { chip: '', text: tr('arr_ask_toast_denied'), tone: 'attention' };
            case 'changed':
            case 'busy':
            case 'gone': return { chip: '', text: tr('arr_ask_toast_changed'), tone: 'attention' };
            case 'cancelled': return { chip: '', text: tr('arr_ask_toast_cancelled'), tone: 'none' };
            case 'declined': return { chip: tr('arr_ask_chip_declined'), text: tr('arr_ask_toast_declined', { contact: who }), tone: 'attention' };
            default: return { chip: '', text: tr('arr_ask_toast_failed'), tone: 'attention' };
        }
    }

    /**
     * Shows a short toast (plain text; escaped before it reaches JE.toast).
     * @param {string} text Text.
     * @param {number} [ms] Duration.
     * @returns {void}
     */
    function toast(text, ms) {
        if (!text) return;
        const safe = typeof JE.escapeHtml === 'function' ? JE.escapeHtml(text) : String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
        if (typeof JE.toast === 'function') JE.toast(safe, ms || 3500);
    }

    /**
     * Follows asks and cancels made on this page (any surface): the callback gets
     * {type: 'ask'|'cancel', key?, input?, requestId?, result}.
     * @param {Function} callback Callback.
     * @returns {() => void} Unsubscribe.
     */
    function onChange(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
    }

    /**
     * Tells listeners and the status surfaces showing the title that something changed.
     * @param {Object} detail Change.
     * @returns {void}
     */
    function emit(detail) {
        listeners.forEach((cb) => {
            try {
                cb(detail);
            } catch (err) {
                console.warn(`${logPrefix} listener failed`, err);
            }
        });
        if (detail.key && JE.arrStatus?.refresh) JE.arrStatus.refresh([detail.key]);
    }

    /**
     * The instance an administrator's Search runs on for a title in scope, from the admin block of
     * the status shown (only administrators get one): the copy that is missing for a long while
     * (the episode's own line first), else the title's main copy (not the 4K one when there is a
     * choice). Null when the caller isn't an administrator, the Manage drawer (whose Search now
     * route this uses) is off, or no instance holds the title.
     * @param {Object|null} caps Capabilities ({@link me}).
     * @param {Object|null} status Status carrying `admin.variants` (title, season or episode).
     * @param {string} key Title key in scope (movie, series, season or episode).
     * @returns {string|null} Instance id.
     */
    function searchInstance(caps, status, key) {
        if (caps?.role !== 'admin' || JE.pluginConfig?.ArrManageDrawerEnabled !== true) return null;
        const variants = Array.isArray(status?.admin?.variants) ? status.admin.variants.filter(v => typeof v?.instanceId === 'string' && v.instanceId) : [];
        const movie = String(key || '').startsWith('movie:');
        const kind = movie ? 'radarr' : 'sonarr';
        const m = /:s(\d+):e(\d+)$/.exec(String(key || ''));
        const scope = m ? `S${m[1].padStart(2, '0')}E${m[2].padStart(2, '0')}` : null;
        const ofKind = variants.filter(v => String(v.kind || '').toLowerCase() === kind);
        const missing = v => v.reason?.code === 'no_release_yet';
        const pick = (scope && ofKind.find(v => v.scope === scope && missing(v)))
            || ofKind.find(v => !v.scope && missing(v))
            || ofKind.find(v => !v.scope && v.role !== '4k')
            || ofKind.find(v => !v.scope);
        return pick ? pick.instanceId : null;
    }

    /**
     * An administrator's Search: runs the arr's own search for exactly the title in scope on one
     * instance right away (POST /JellyfinEnhanced/arr/admin/manage/search, audited on the server)
     * and says honestly what it found: a grab ("Found a copy — downloading"), nothing ("Nothing
     * found yet · searched just now"), still running, or that it didn't work. The title's surfaces
     * then read their status again.
     * @param {string} key Title key in scope.
     * @param {string} instanceId Instance ({@link searchInstance}).
     * @returns {Promise<{ok: boolean, state: string, chip: string, text: string, tone: string}>} Result.
     */
    async function adminSearch(key, instanceId) {
        let answer;
        try {
            answer = await call('/arr/admin/manage/search', { method: 'POST', body: { instanceId, key, idempotencyKey: newClientId() } });
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            const text = tr('arr_manage_search_failed', { message: err?.message || String(err) });
            return { ok: false, state: 'failed', chip: '', text, tone: 'attention' };
        }
        const body = answer.body || {};
        let result;
        if (answer.status !== 200 || body.status === 'Failed' || body.status === 'Rejected') {
            const message = typeof body.message === 'string' && body.message ? body.message : (typeof body.code === 'string' ? body.code : String(answer.status));
            result = { ok: false, state: 'failed', chip: '', text: tr('arr_manage_search_failed', { message }), tone: 'attention' };
        } else if (body.found === true) {
            result = { ok: true, state: 'found', chip: tr('arr_search_found_chip'), text: tr('arr_search_found'), tone: 'downloading' };
        } else if (body.found === false) {
            result = { ok: true, state: 'nothing', chip: tr('arr_search_nothing_chip'), text: tr('arr_search_nothing'), tone: 'notHere' };
        } else {
            result = { ok: true, state: 'running', chip: tr('arr_search_running_chip'), text: tr('arr_search_running'), tone: 'looking' };
        }
        if (result.ok) emit({ type: 'search', key, result });
        return result;
    }

    /**
     * A series' seasons from JE's TMDB proxy (parental-gated on the server): episode counts of the
     * aired seasons, the latest aired one and the next one to come. Empty when the id is not a TMDB id
     * or TMDB can't be read.
     * @param {string|number|undefined} tmdbId TMDB id.
     * @returns {Promise<{seasons: Array<{season: number, episodes: number, have: number}>, latest: number|null, upcoming: number|null}>} Seasons.
     */
    async function tmdbSeasons(tmdbId) {
        const empty = { seasons: [], latest: null, upcoming: null };
        if (!/^\d{1,10}$/.test(String(tmdbId || ''))) return empty;
        let body = null;
        try {
            const answer = await call(`/tmdb/tv/${tmdbId}`);
            body = answer.status === 200 ? answer.body : null;
        } catch {
            return empty;
        }
        const today = new Date().toISOString().slice(0, 10);
        const list = (Array.isArray(body?.seasons) ? body.seasons : []).filter(s => Number.isInteger(s?.season_number) && s.season_number > 0);
        const aired = list.filter(s => typeof s.air_date === 'string' && s.air_date <= today);
        const seasons = aired.map(s => ({ season: s.season_number, episodes: Number(s.episode_count) || 0, have: 0 }));
        const upcoming = list.find(s => !(typeof s.air_date === 'string' && s.air_date <= today));
        return { seasons, latest: aired.length ? aired[aired.length - 1].season_number : null, upcoming: upcoming ? upcoming.season_number : null };
    }

    JE.session?.onUserChange?.('arr-ask', () => {
        meState = null;
        openIds.clear();
    });

    JE.arrAsk = Object.freeze({
        enabled,
        epoch,
        me,
        contact,
        ask,
        cancel,
        quota,
        describe,
        interpret,
        toast,
        onChange,
        fingerprint,
        newClientId,
        movieInput,
        seasonsInput,
        episodesInput,
        seriesKey,
        searchInstance,
        adminSearch,
        tmdbSeasons,
        call,
        tr
    });
})(window.JellyfinEnhanced);
