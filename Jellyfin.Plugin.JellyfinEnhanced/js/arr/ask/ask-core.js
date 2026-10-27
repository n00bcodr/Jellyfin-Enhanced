/**
 * @file Requests & downloads, phase 3: asking for titles from the client. One place that talks to
 * the request API (POST /JellyfinEnhanced/acquire/requests, its cancel route, GET .../me and
 * .../quota), keeps a retry-safe clientRequestId per tap (a retry after a lost answer reuses it, so
 * the server never records the same ask twice), turns every answer into honest family words (request
 * outcomes: waiting for an OK, asked, already asked by someone, quota, blocked, couldn't ask) and
 * tells the surfaces showing the title to refresh (JE.arrStatus.refresh and JE.arrAsk.onChange).
 * Also an administrator's Search for a title missing for a long while (searchInstance, adminSearch:
 * the arr's own search through the Manage drawer's audited route; everyone else asks instead), and
 * why a title can't be asked for right now (check, paused, blockWords: "Paused: storage full").
 * Exposes JE.arrAsk; the request controls (season rows, request sheet, smart actions, hub tabs) all
 * build on it. Everything is off unless the server's ArrRequestsEnabled flag is on.
 */
(function (JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Ask:';
    /** How long the caller's capabilities are reused before asking the server again. */
    const ME_TTL_MS = 60000;
    /** Reasons of an accepted ask that mean "waits for an OK". */
    const WAITING = new Set(['awaiting_approval', 'over_quota', 'seerr_whole_series_only', 'authorization_changed', 'identity_changed', 'configuration_changed', 'seerr_user_unlinked', 'no_4k_instance', 'rule_review', 'group_quota']);

    let meState = null; // { at, epoch (cacheEpoch), promise, value }
    /**
     * The pending submission of each input fingerprint (D46S2-R13-4): { id: its clientRequestId, epoch: the session it
     * started in }, kept until that submission's definitive answer. A retry of the same pending ask reuses it; an answer
     * removes only its own submission's entry, and only while that entry is still the installed one, so an older ask
     * answered late (after a newer one replaced it, or after another account signed in) never takes a newer ask's id.
     * @type {Map<string, {id: string, epoch: number}>}
     */
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
     * The key of this module's caches (D46S2-R11-9): the session epoch and the requests family's write epoch (every
     * ask, cancel or follow moves it as it is sent and as it is answered), so a capability or title check read after a
     * write never comes from one that started before it.
     * @returns {string} Key.
     */
    function cacheEpoch() {
        return `${epoch()}:${JE.core?.api?.writeEpoch ? JE.core.api.writeEpoch('acquire') : 0}`;
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
        return JE.core.api.pluginResponse(path, options);
    }

    /**
     * The caller's own request capabilities ({role, canRequest, canRequestMovies, canRequestSeries,
     * canApprove, asksFirst, can4kMovies, can4kSeries, backend, seerrWholeSeries, contact, freeEpisodes}), cached for a
     * minute per user (see canAsk for one kind); null when the
     * feature is off or the server can't say.
     * @param {boolean} [force] Ask the server again.
     * @returns {Promise<Object|null>} Capabilities.
     */
    function me(force) {
        if (!enabled()) return Promise.resolve(null);
        const now = Date.now();
        const current = cacheEpoch();
        if (!force && meState && meState.epoch === current && (meState.promise || now - meState.at < ME_TTL_MS)) {
            return meState.promise || Promise.resolve(meState.value);
        }
        const state = { at: now, epoch: current, promise: null, value: null };
        meState = state;
        state.promise = call('/acquire/requests/me').then((answer) => {
            const value = answer.status === 200 && answer.body?.me ? answer.body.me : null;
            if (meState === state) {
                // Kept for a minute from when it was ASKED (state.at): a reply that took long to arrive was decided
                // then, not when it came in.
                state.value = value;
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
     * True when single episodes can't be asked for: in Seerr mode Seerr takes whole seasons, so an episode is asked
     * for as its season (said on the control before anything is sent, never rounded up behind the person's back).
     * @param {Object|null} caps Capabilities ({@link me}).
     * @returns {boolean} Seasons only.
     */
    function seasonsOnly(caps) {
        return caps?.backend === 'seerr';
    }

    /**
     * True when Seerr takes a request for the whole series only (its partial-request setting is off): the controls
     * then offer the whole series.
     * @param {Object|null} caps Capabilities ({@link me}).
     * @returns {boolean} Whole series only.
     */
    function wholeSeriesOnly(caps) {
        return seasonsOnly(caps) && caps?.seerrWholeSeries === true;
    }

    /**
     * True when the administrator allows one season per ask ("Only allow requesting one season at a time" on the Seerr
     * tab; in Seerr mode only while Seerr takes partial requests): the series controls then ask for one season at a time.
     * @param {Object|null} caps Capabilities ({@link me}).
     * @returns {boolean} One season at a time.
     */
    function singleSeasonOnly(caps) {
        return caps?.singleSeason === true && !wholeSeriesOnly(caps);
    }

    /**
     * What a control that would ask for single episodes is called in Seerr mode, so it says what it asks for before
     * it is pressed: "Get Season 2", "Get Seasons 1, 3", or "Get the whole series" (partial requests off in Seerr);
     * "Ask Dad for Season 2" and so on when the caller's asks wait for an OK and the control says so.
     * @param {Object|null} caps Capabilities ({@link me}).
     * @param {number[]} seasons The seasons of the episodes.
     * @param {boolean} [asks] Name the contact (the control's other labels do).
     * @returns {string} Label.
     */
    function roundedLabel(caps, seasons, asks) {
        if (wholeSeriesOnly(caps)) return asks ? tr('arr_ask_ask_series', { contact: contact(caps) }) : tr('arr_ask_get_series');
        return seasonsLabel(caps, seasons, asks);
    }

    /**
     * A control's label naming the seasons it asks for: "Get Season 2", "Get Seasons 1, 3" ("Ask Dad for Season 2"
     * when the control names the contact).
     * @param {Object|null} caps Capabilities ({@link me}).
     * @param {number[]} seasons Seasons.
     * @param {boolean} [asks] Name the contact.
     * @returns {string} Label.
     */
    function seasonsLabel(caps, seasons, asks) {
        const who = contact(caps);
        const sorted = [...new Set(seasons || [])].sort((a, b) => a - b);
        if (sorted.length === 1) return asks ? tr('arr_actions_ask_season', { contact: who, season: sorted[0] }) : tr('arr_actions_get_season', { season: sorted[0] });
        const list = sorted.join(', ');
        return asks ? tr('arr_ask_ask_seasons', { contact: who, list }) : tr('arr_ask_get_seasons', { list });
    }

    /**
     * Why a control asks for more than the episode in Seerr mode ("Seerr takes whole seasons, so this asks for all of
     * Season 2."), for its explanatory line and its accessible name.
     * @param {Object|null} caps Capabilities ({@link me}).
     * @param {number[]} seasons The seasons of the episodes.
     * @returns {string} Sentence.
     */
    function roundedNote(caps, seasons) {
        return wholeSeriesOnly(caps) ? tr('arr_ask_seerr_series_note') : tr('arr_ask_seerr_season_note', { seasons: seasonsWords(seasons) });
    }

    /**
     * The ask of a control that would ask for single episodes, as Seerr takes it: their seasons, or the whole series
     * (partial requests off in Seerr). Null when the series' seasons can't be read.
     * @param {string} key Series (or season/episode) key.
     * @param {Object|null} caps Capabilities ({@link me}).
     * @param {number[]} seasons The seasons of the episodes.
     * @param {string} [variant] standard or 4k.
     * @returns {Promise<Object|null>} Input.
     */
    async function roundedInput(key, caps, seasons, variant) {
        return wholeSeriesOnly(caps) ? wholeSeriesInput(key, variant) : seasonsInput(key, seasons, variant);
    }

    /**
     * The whole series as one ask (Seerr with partial requests off): every season it has, specials left out, from
     * the season numbers given, else the series' own status, else TMDB's season list. Null when they can't be read.
     * @param {string} key Series (or season/episode) key.
     * @param {string} [variant] standard or 4k.
     * @param {number[]} [known] Season numbers already known.
     * @returns {Promise<Object|null>} Input.
     */
    async function wholeSeriesInput(key, variant, known) {
        const series = seriesKey(key);
        const pick = list => [...new Set((list || []).filter(n => Number.isInteger(n) && n > 0))];
        let seasons = pick(known);
        if (!seasons.length && JE.arrStatus?.fetchKey) {
            try {
                const read = await JE.arrStatus.fetchKey(series);
                seasons = pick((read?.items?.[0]?.seasons || []).map(s => s?.season));
            } catch {
                seasons = [];
            }
        }
        if (!seasons.length) {
            const tmdb = /^tv:tmdb:(\d{1,10})$/.exec(series)?.[1];
            if (tmdb) seasons = pick((await tmdbSeasons(tmdb)).seasons.map(s => s.season));
        }
        return seasons.length ? seasonsInput(series, seasons, variant) : null;
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
     * @param {Object|null} body Response body ({outcome, reason, certainty, message, requestId, rules}).
     * @returns {{ok: boolean, status: number, state: string, outcome: string, reason: string, certainty: string, requestId: string|null}} Result
     *     (state 'ruled' for a refusal by the household rules; rules: their verdict, when the server sent one).
     */
    function interpret(status, body) {
        const outcome = typeof body?.outcome === 'string' ? body.outcome : '';
        const reason = typeof body?.reason === 'string' ? body.reason : '';
        const certainty = typeof body?.certainty === 'string' ? body.certainty : '';
        const requestId = typeof body?.requestId === 'string' ? body.requestId : null;
        const heldSeasons = Array.isArray(body?.heldSeasons) ? body.heldSeasons.filter(n => Number.isInteger(n) && n >= 0) : [];
        let state;
        if (status === 202 || outcome === 'maybe_sent' || certainty === 'Unknown') state = 'unknown';
        else if (status >= 200 && status < 300) {
            if (outcome === 'split') state = 'split';
            else if (outcome === 'merged' || outcome === 'already_requested') state = 'merged';
            else if (outcome === 'nothing_to_request' || reason === 'nothing_to_request') state = 'nothing';
            else if (WAITING.has(reason)) state = 'waiting';
            else if (reason === 'declined') state = 'declined';
            else state = 'asked';
        } else if (status === 429) state = 'quota';
        else if (status === 409 && (reason === 'seerr_whole_season_only' || reason === 'single_season_only')) state = 'blocked';
        // The server refused a press that no longer does what it was drawn to do, or couldn't check it (nothing was recorded).
        else if (status === 409 && reason === 'press_unverified') state = 'unchecked';
        else if (status === 409) state = reason === 'idempotency_conflict' || reason === 'press_changed' ? 'changed' : 'busy';
        else if (status === 503) state = 'unavailable';
        else if (status === 400) state = 'invalid';
        else if (status === 403 && reason === 'household_rule') state = 'ruled';
        else if (status === 403 && (outcome === 'blocked' || reason === 'decline_cooldown' || reason === 'not_visible_to_user' || reason === 'low_disk')) state = 'blocked';
        else if (status === 403) state = 'denied';
        else if (status === 404) state = 'gone';
        else state = 'failed';
        const result = { ok: status >= 200 && status < 300, status, state, outcome, reason, certainty, requestId };
        if (state === 'split') result.heldSeasons = heldSeasons;
        // Phase 4b: the household rules' verdict behind a refusal or a wait for an OK.
        if (body?.rules && typeof body.rules === 'object') result.rules = body.rules;
        return result;
    }

    /**
     * "Season 5" / "Seasons 5–6" / "Seasons 5, 7" for the seasons of a split ask that wait for an OK.
     * @param {number[]} seasons Season numbers.
     * @returns {string} Text ('' for none).
     */
    function seasonsWords(seasons) {
        const sorted = [...new Set(seasons || [])].sort((a, b) => a - b);
        if (sorted.length === 0) return '';
        if (sorted.length === 1) return tr('arr_hub_season', { list: sorted[0] });
        const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
        return tr('arr_hub_seasons', { list: contiguous ? `${sorted[0]}–${sorted[sorted.length - 1]}` : sorted.join(', ') });
    }

    /**
     * Asks for a title (movie, seasons or episodes). A double tap or a retry of the same ask after a
     * lost answer reuses the same clientRequestId; a definitive answer (any HTTP status but 5xx) ends it.
     * On success the surfaces showing the title refresh.
     * @param {Object} input Mutation input (see movieInput / seasonsInput / episodesInput).
     * @param {{clientRequestId?: string, signal?: AbortSignal, bound?: Object, expect?: Object}} [options] Options; bound: the
     *     core transport binding of the operation that asks (JE.captureSubmitted(owner).bound()), checked right before the
     *     POST; `expect` is what a season page's control was drawn to do (the server works it out again and refuses any
     *     difference: state 'changed').
     * @returns {Promise<Object>} Result (see {@link interpret}); state 'failed' when no answer came, plus `stale`
     *     when a bound ask was never sent (its operation or session ended), or `stale` and `accepted` (with the server's
     *     answer) when it was answered after its owner ended: its state is reconciled, nothing is said.
     */
    async function ask(input, options) {
        if (!enabled()) return { ok: false, status: 0, state: 'off', outcome: '', reason: 'feature_disabled', certainty: '', requestId: null };
        const print = fingerprint(input);
        const started = epoch();
        const installed = openIds.get(print);
        const entry = installed && installed.epoch === started && (!options?.clientRequestId || options.clientRequestId === installed.id)
            ? installed : { id: options?.clientRequestId || newClientId(), epoch: started };
        openIds.set(print, entry);
        const clientRequestId = entry.id;
        /** A definitive answer ends this submission: its own entry goes, never one that replaced it. */
        const settle = () => { if (openIds.get(print) === entry) openIds.delete(print); };
        let answer;
        try {
            answer = await call('/acquire/requests', { method: 'POST', body: options?.expect ? { clientRequestId, input, expect: options.expect } : { clientRequestId, input }, signal: options?.signal, bound: options?.bound });
        } catch (err) {
            // Three outcomes (D46S2-R11-9). Answered after its owner ended (accepted): the server took it, so this
            // session's state is reconciled (the clientRequestId is spent, the capability and title checks go, the
            // surfaces showing the title re-read) with no page effect (`stale`: nobody is told on a newer page).
            // Answered after another account signed in (D46S2-R12-4): still accepted — the origin's key is spent and its
            // caches went with its session (onUserChange) — and nothing reaches the new account (no change event).
            const written = JE.core.api.writeOutcome ? JE.core.api.writeOutcome(err) : { outcome: 'failed', sent: false };
            if (written.outcome === 'accepted') {
                const answered = written.answer || {};
                if (!(answered.status >= 500)) settle();
                const result = { ...interpret(answered.status || 0, answered.body), clientRequestId, stale: true, accepted: true, sessionChanged: written.sessionChanged };
                if (!written.sessionChanged && started === epoch() && (result.ok || result.state === 'unknown')) {
                    meState = null;
                    checks.clear();
                    emit({ type: 'ask', key: input.key, input, result });
                }
                return result;
            }
            // Never sent (D46S2-R13-5: the transport's outcome says so, never the error's name): bound to an operation or
            // session that ended before the send, nothing was sent and there is nothing to say; a caller's own abort
            // before the send is its own.
            if (written.outcome === 'unsent') {
                if (options?.bound) return { ok: false, status: 0, state: 'failed', outcome: '', reason: 'aborted', certainty: '', requestId: null, clientRequestId, stale: true };
                if (err?.name === 'AbortError') throw err;
            }
            // Sent, and its answer lost (an abort or a network failure after the send): the server may or may not have
            // taken it. Uncertain, never an unsent cancellation; the id stays, so a retry is the same ask.
            if (written.sent) {
                console.warn(`${logPrefix} ask sent, no answer (${err?.message || err})`);
                return { ok: false, status: 0, state: 'failed', outcome: '', reason: 'uncertain', certainty: '', requestId: null, clientRequestId, sent: true };
            }
            console.warn(`${logPrefix} ask failed (${err?.message || err})`);
            return { ok: false, status: 0, state: 'failed', outcome: '', reason: 'network', certainty: '', requestId: null, clientRequestId };
        }
        // A server error may or may not have recorded the ask: keep the id so a retry is the same ask.
        if (answer.status < 500) settle();
        const result = { ...interpret(answer.status, answer.body), clientRequestId };
        if (started !== epoch()) return { ...result, stale: true };
        if (result.ok || result.state === 'unknown') {
            meState = null;
            checks.clear();
            emit({ type: 'ask', key: input.key, input, result });
        }
        return result;
    }

    /**
     * Cancels the caller's own request that hasn't been sent yet.
     * @param {string} requestId Request id.
     * @param {{bound?: Object}} [options] bound: the operation's transport binding (as {@link ask}).
     * @returns {Promise<Object>} Result (state 'cancelled' on success).
     */
    async function cancel(requestId, options) {
        if (!enabled() || !/^[0-9a-f]{32}$/i.test(String(requestId || ''))) return { ok: false, status: 0, state: 'invalid', outcome: '', reason: 'invalid_id', certainty: '', requestId: null };
        let answer;
        let accepted = false;
        try {
            answer = await call(`/acquire/requests/${encodeURIComponent(requestId)}/cancel`, { method: 'POST', body: {}, bound: options?.bound });
        } catch (err) {
            // Three outcomes (D46S2-R11-9): answered after its owner ended, the cancel happened (reconciled below, said by
            // nobody); never sent, nothing happened.
            const written = options?.bound && JE.core.api.writeOutcome ? JE.core.api.writeOutcome(err) : null;
            if (written?.outcome === 'accepted' && !written.sessionChanged) { answer = written.answer || { status: 0, body: null }; accepted = true; }
            // Taken after another account signed in (D46S2-R12-4): it happened, for the origin only; nothing for the new one.
            else if (written?.outcome === 'accepted') return { ...interpret(written.answer?.status || 0, written.answer?.body), requestId, stale: true, accepted: true, sessionChanged: true };
            else if (written?.outcome === 'unsent') return { ok: false, status: 0, state: 'failed', outcome: '', reason: 'aborted', certainty: '', requestId, stale: true };
            // Sent with its answer lost: uncertain, said as a failure to retry, never as never-sent (D46S2-R13-5).
            else if (written?.sent) return { ok: false, status: 0, state: 'failed', outcome: '', reason: 'uncertain', certainty: '', requestId, sent: true };
            else {
                console.warn(`${logPrefix} cancel failed (${err?.message || err})`);
                return { ok: false, status: 0, state: 'failed', outcome: '', reason: 'network', certainty: '', requestId };
            }
        }
        const result = interpret(answer.status, answer.body);
        if (result.ok) {
            result.state = 'cancelled';
            meState = null;
            checks.clear();
            emit({ type: 'cancel', requestId, result });
        }
        return accepted ? { ...result, stale: true, accepted: true } : result;
    }

    /**
     * The caller's request allowance ({used, limit, remaining, nextSlotAt, usedGb, available}, and the shared allowance
     * their requests draw on as pool: {name, used, limit, remaining, nextSlotAt} when there is one), or null.
     * @param {'movie'|'tv'} mediaType Kind.
     * @returns {Promise<Object|null>} Quota.
     */
    async function quota(mediaType) {
        if (!enabled()) return null;
        try {
            const answer = await call(`/acquire/requests/quota?mediaType=${mediaType === 'tv' ? 'tv' : 'movie'}`);
            if (answer.status !== 200 || !answer.body?.quota) return null;
            return answer.body.pool && typeof answer.body.pool === 'object' ? { ...answer.body.quota, pool: answer.body.pool } : answer.body.quota;
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
            case 'waiting': {
                // Phase 4b: the household rules want a look (with the facts behind it), or the shared allowance is used up.
                const why = result.reason === 'rule_review' ? ruleWhy(result.rules) : '';
                const text = result.reason === 'over_quota' ? tr('arr_ask_toast_over_quota', { contact: who })
                    : result.reason === 'rule_review' ? (why ? tr('arr_rules_toast_review', { contact: who, why }) : tr('arr_rules_toast_review_plain', { contact: who }))
                        : result.reason === 'group_quota' ? tr('arr_rules_toast_pool', { contact: who }) : tr('arr_ask_toast_waiting', { contact: who });
                return { chip: tr('arr_ask_chip_waiting'), text, tone: 'asked' };
            }
            case 'ruled': {
                const why = ruleWhy(result.rules);
                return { chip: '', text: why ? tr('arr_rules_toast_refused', { why }) : tr('arr_rules_toast_refused_plain'), tone: 'attention' };
            }
            case 'asked': return { chip: tr('arr_ask_chip_asked'), text: tr('arr_ask_toast_asked'), tone: 'approved' };
            case 'split': return { chip: tr('arr_ask_chip_asked'), text: tr('arr_ask_toast_split', { contact: who, seasons: seasonsWords(result.heldSeasons) }), tone: 'approved' };
            case 'merged': return { chip: tr('arr_ask_chip_asked'), text: tr('arr_ask_toast_merged'), tone: 'approved' };
            case 'nothing': return { chip: '', text: tr('arr_ask_toast_nothing'), tone: 'none' };
            case 'unknown': return { chip: tr('arr_ask_chip_asked'), text: tr('arr_ask_toast_unknown'), tone: 'approved' };
            case 'quota': {
                const day = allowance?.nextSlotAt && JE.arrStatus ? JE.arrStatus.formatDate(allowance.nextSlotAt) : '';
                return { chip: '', text: day ? tr('arr_ask_toast_quota_day', { day }) : tr('arr_ask_toast_quota'), tone: 'attention' };
            }
            case 'blocked':
                return {
                    chip: '',
                    text: result.reason === 'decline_cooldown' ? tr('arr_ask_toast_cooldown', { contact: who })
                        : result.reason === 'low_disk' ? tr('arr_ask_toast_storage')
                            : result.reason === 'seerr_whole_season_only' ? tr('arr_ask_toast_seerr_season')
                                : result.reason === 'single_season_only' ? tr('arr_ask_toast_single_season') : tr('arr_ask_toast_blocked'),
                    tone: 'attention'
                };
            case 'denied': return { chip: '', text: tr('arr_ask_toast_denied'), tone: 'attention' };
            case 'unchecked': return { chip: '', text: tr('arr_ask_check_failed'), tone: 'attention' };
            case 'changed':
            case 'busy':
            case 'gone': return { chip: '', text: tr('arr_ask_toast_changed'), tone: 'attention' };
            case 'cancelled': return { chip: '', text: tr('arr_ask_toast_cancelled'), tone: 'none' };
            case 'declined': return { chip: tr('arr_ask_chip_declined'), text: tr('arr_ask_toast_declined', { contact: who }), tone: 'attention' };
            default: return { chip: '', text: tr('arr_ask_toast_failed'), tone: 'attention' };
        }
    }

    /**
     * The facts behind a household-rule verdict in words ("rated R (limit PG-13)"), '' when there are none (phase 4b;
     * worded by arr/household/household-rules.js).
     * @param {Object|null|undefined} rules Verdict.
     * @returns {string} Text.
     */
    function ruleWhy(rules) {
        const words = JE.internals?.arrHub?.rules?.whyText;
        return rules && typeof words === 'function' ? words(rules) : '';
    }

    /**
     * Bytes as "412 GB" / "800 MB" ('' when unknown).
     * @param {number} bytes Bytes.
     * @returns {string} Text.
     */
    function size(bytes) {
        if (typeof bytes !== 'number' || !(bytes >= 0)) return '';
        if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
        if (bytes >= 1e9) return `${Math.round(bytes / 1e9)} GB`;
        return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
    }

    /**
     * The words for why someone who may ask can't ask for a title right now (a block from the season rows, a
     * title check or the capabilities' pausedMovies / pausedSeries): the short chip that takes the place of Get it
     * ("Paused: storage full"), the family sentence, and for administrators where and how much is free (the server
     * sends those only to them). Null when there is no block.
     * @param {Object|null} block Block ({reason, instance?, folder?, free?, freePercent?, limitPercent?}).
     * @param {Object|null} [caps] Capabilities (contact word, role).
     * @returns {{reason: string, chip: string, text: string, detail: string}|null} Words.
     */
    function blockWords(block, caps) {
        const reason = typeof block?.reason === 'string' ? block.reason : '';
        if (!reason) return null;
        const who = contact(caps);
        if (reason === 'low_disk') {
            const detail = typeof block.folder === 'string' && block.folder
                ? tr('arr_ask_paused_storage_admin', {
                    instance: String(block.instance || ''), folder: block.folder, free: size(block.free),
                    percent: Number.isFinite(block.freePercent) ? block.freePercent : '', limit: Number.isFinite(block.limitPercent) ? block.limitPercent : ''
                })
                : '';
            return { reason, chip: tr('arr_ask_paused_storage'), text: tr('arr_ask_paused_storage_text', { contact: who }), detail };
        }
        return { reason, chip: tr('arr_ask_paused_other'), text: tr('arr_ask_paused_other_text', { contact: who }), detail: caps?.role === 'admin' ? tr('arr_ask_paused_other_admin', { reason }) : '' };
    }

    /**
     * A paused line for a page or a sheet: icon, the chip words ("Paused: storage full") and the sentence (for
     * administrators where and how much is free). Plain text only.
     * @param {{chip: string, text: string, detail: string}} words Words ({@link blockWords}).
     * @returns {HTMLElement} Line.
     */
    function pausedNote(words) {
        const S = JE.arrStatus;
        const note = S.el('div', 'je-ask-paused-note');
        note.setAttribute('role', 'note');
        note.appendChild(S.icon('storage', 'je-ask-paused-icon'));
        const body = S.el('div', 'je-ask-paused-body');
        body.appendChild(S.el('strong', 'je-ask-paused-title', words.chip));
        body.appendChild(S.el('span', 'je-ask-paused-text', words.detail || words.text));
        note.appendChild(body);
        return note;
    }

    /**
     * The storage pause for asking for a new title of this kind (capabilities' pausedMovies / pausedSeries), or null.
     * @param {Object|null} caps Capabilities ({@link me}).
     * @param {string} kind 'movie', or anything else for a series.
     * @returns {Object|null} Block.
     */
    function paused(caps, kind) {
        const block = kind === 'movie' ? caps?.pausedMovies : caps?.pausedSeries;
        return block && typeof block.reason === 'string' ? block : null;
    }

    /** @type {Map<string, {at: number, epoch: string, promise: Promise<Object|null>}>} title checks by key|variant (cacheEpoch), briefly */
    const checks = new Map();
    /** How long a title check is reused. */
    const CHECK_TTL_MS = 30000;

    /**
     * Whether the caller may ask for one title now, and if not, why (GET .../acquire/requests/check): {canRequest,
     * blocked}. Reused for half a minute per title and edition (an ask on the page reads it again). Null when the
     * feature is off or the server can't say (the controls then show as before).
     * @param {string} key Title key (movie, series, season or episode key).
     * @param {string} [variant] standard or 4k.
     * @returns {Promise<{canRequest: boolean, blocked: Object|null}|null>} Check.
     */
    function check(key, variant) {
        if (!enabled() || !key) return Promise.resolve(null);
        const edition = variant === '4k' ? '4k' : 'standard';
        const id = `${key}|${edition}`;
        const now = Date.now();
        const current = cacheEpoch();
        const hit = checks.get(id);
        if (hit && hit.epoch === current && now - hit.at < CHECK_TTL_MS) return hit.promise;
        const promise = call(`/acquire/requests/check?key=${encodeURIComponent(key)}&variant=${edition}`)
            .then(answer => (answer.status === 200 && answer.body?.check ? { canRequest: answer.body.check.canRequest === true, blocked: answer.body.check.blocked || null } : null))
            .catch(() => null);
        checks.set(id, { at: now, epoch: current, promise });
        if (checks.size > 200) checks.delete(checks.keys().next().value);
        return promise;
    }

    /** @type {HTMLElement|null} the one visually hidden live region request outcomes are read out from */
    let liveRegion = null;

    /**
     * Reads a line out to screen readers through one persistent, visually hidden live region (made on
     * first use; it outlives the sheet or button the outcome came from). The text is set a moment after
     * clearing it, so the same words twice are read out twice.
     * @param {string} text Plain text.
     * @returns {void}
     */
    function announce(text) {
        if (!text || !document.body) return;
        if (!liveRegion || !liveRegion.isConnected) {
            liveRegion = document.createElement('div');
            liveRegion.className = 'je-ask-live';
            liveRegion.setAttribute('role', 'status');
            liveRegion.setAttribute('aria-live', 'polite');
            liveRegion.setAttribute('aria-atomic', 'true');
            Object.assign(liveRegion.style, {
                position: 'absolute', width: '1px', height: '1px', margin: '-1px', padding: '0', border: '0',
                overflow: 'hidden', clip: 'rect(0 0 0 0)', clipPath: 'inset(50%)', whiteSpace: 'nowrap'
            });
            document.body.appendChild(liveRegion);
        }
        const region = liveRegion;
        region.textContent = '';
        setTimeout(() => { region.textContent = String(text); }, 50);
    }

    /**
     * Shows a short toast (plain text; escaped before it reaches JE.toast) and reads it out to screen
     * readers (the toast itself isn't a live region).
     * @param {string} text Text.
     * @param {number} [ms] Duration.
     * @returns {void}
     */
    function toast(text, ms) {
        if (!text) return;
        // A translation's {{icon:…}} arrives as JE's emoji markup: shown as its emoji, never as escaped tags.
        text = String(text).replace(/<span class="je-emoji">([^<]*)<\/span>/g, '$1');
        const safe = typeof JE.escapeHtml === 'function' ? JE.escapeHtml(text) : String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
        if (typeof JE.toast === 'function') JE.toast(safe, ms || 3500);
        announce(text);
    }

    /**
     * True when the caller may ask for this kind of title. Movies and series can differ (in Seerr mode
     * Seerr's per-kind request permissions decide); an older answer without the per-kind flags falls
     * back to canRequest.
     * @param {Object|null} caps Capabilities (see me).
     * @param {string} kind 'movie', or anything else for a series.
     * @returns {boolean} May ask.
     */
    function canAsk(caps, kind) {
        if (!caps?.canRequest) return false;
        const flag = kind === 'movie' ? caps.canRequestMovies : caps.canRequestSeries;
        return typeof flag === 'boolean' ? flag : true;
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
     * True when a Search by this caller would be a new ask that waits for an OK: their asks wait for one (a Kid,
     * or "approve everything") and no request covering the part has gone out yet. When one has (the missing
     * status carries `reason.params.sent`), Search runs the arr's search for it again with no new request, so no
     * OK: the button then reads plain "Search".
     * @param {Object|null} caps Capabilities ({@link me}).
     * @param {Object|null} status The missing movie's or episode's status.
     * @returns {boolean} The Search asks first.
     */
    function searchAsksFirst(caps, status) {
        return !!caps?.asksFirst && status?.reason?.params?.sent !== '1';
    }

    /**
     * An administrator's Search: runs the arr's own search for exactly the title in scope on one
     * instance right away (POST /JellyfinEnhanced/arr/admin/manage/search, audited on the server)
     * and says honestly what it found: a grab ("Found a copy — downloading"), nothing ("Nothing
     * found yet · searched just now"), still running, or that it didn't work. The title's surfaces
     * then read their status again.
     * @param {string} key Title key in scope.
     * @param {string} instanceId Instance ({@link searchInstance}).
     * @param {{episodes?: number[], expect?: Object, bound?: Object}} [options] A season key's episodes to search (exactly
     * those), what a season page's control was drawn to do (the server works it out again: a refusal is state 'changed' or
     * 'unchecked'), and bound: the core transport binding of the operation that searches (if any), checked right before the
     * POST (an AbortError when it ended first: nothing was sent).
     * @returns {Promise<{ok: boolean, state: string, chip: string, text: string, tone: string, reason?: string}>} Result.
     */
    async function adminSearch(key, instanceId, options) {
        let answer;
        const payload = { instanceId, key, idempotencyKey: newClientId() };
        if (options?.episodes?.length) payload.episodes = options.episodes;
        if (options?.expect) payload.expect = options.expect;
        let accepted = false;
        let sessionChanged = false;
        try {
            answer = await call('/arr/admin/manage/search', { method: 'POST', body: payload, bound: options?.bound });
        } catch (err) {
            // Three outcomes (D46S2-R11-9), decided by the transport (D46S2-R13-5), never by the error's name: answered
            // after its owner ended or after another account signed in → the answer is read below like any other
            // (D46S2-R13-6) and only its origin is reconciled; never sent → the caller's never-sent abort; sent with its
            // answer lost → a failure to report (it may have run).
            const written = searchOutcome(err);
            if (written.outcome === 'accepted') { answer = written.answer || { status: 0, body: null }; accepted = true; sessionChanged = written.sessionChanged; }
            else if (written.outcome === 'unsent' && err?.name === 'AbortError') throw err;
            else return { ok: false, state: 'failed', chip: '', text: tr('arr_manage_search_failed', { message: err?.message || String(err) }), tone: 'attention', ...(written.sent ? { sent: true } : {}) };
        }
        const body = answer.body || {};
        let result;
        if (answer.status === 409 && (body.code === 'press_changed' || body.code === 'press_unverified')) {
            result = { ok: false, state: body.code === 'press_changed' ? 'changed' : 'unchecked', reason: body.code, chip: '', text: tr(body.code === 'press_changed' ? 'arr_ask_changed' : 'arr_ask_check_failed'), tone: 'attention' };
        } else if (answer.status !== 200 || body.status === 'Failed' || body.status === 'Rejected') {
            const message = typeof body.message === 'string' && body.message ? body.message : (typeof body.code === 'string' ? body.code : String(answer.status));
            result = { ok: false, state: 'failed', chip: '', text: tr('arr_manage_search_failed', { message }), tone: 'attention' };
        } else if (body.found === true) {
            result = { ok: true, state: 'found', chip: tr('arr_search_found_chip'), text: tr('arr_search_found'), tone: 'downloading' };
        } else if (body.found === false) {
            result = { ok: true, state: 'nothing', chip: tr('arr_search_nothing_chip'), text: tr('arr_search_nothing'), tone: 'notHere' };
        } else {
            result = { ok: true, state: 'running', chip: tr('arr_search_running_chip'), text: tr('arr_search_running'), tone: 'looking' };
        }
        return searched(result, key, accepted, sessionChanged);
    }

    /** The transport's outcome of a Search's error (D46S2-R13-5): unsent, accepted (answered after its owner ended) or failed (`sent`). */
    function searchOutcome(err) {
        return JE.core.api.writeOutcome ? JE.core.api.writeOutcome(err) : { outcome: err?.name === 'AbortError' ? 'unsent' : 'failed', sent: false };
    }

    /**
     * A Search's interpreted answer as its caller gets it (D46S2-R13-6): answered for a current owner, the title's
     * surfaces re-read on success; answered after its owner ended, `stale` and `accepted` with the same business
     * result (a rejection stays a failure, a success a success) and the origin session's surfaces re-read; answered
     * after another account signed in, also `sessionChanged`, and nothing reaches the new account.
     */
    function searched(result, key, accepted, sessionChanged) {
        if (result.ok && !sessionChanged) emit({ type: 'search', key, result });
        return accepted ? { ...result, stale: true, accepted: true, ...(sessionChanged ? { sessionChanged: true } : {}) } : result;
    }

    /**
     * Search for someone who doesn't manage the arrs (POST /JellyfinEnhanced/acquire/requests/search):
     * when requests already sent the movie, the episode, or every episode of the series or season in
     * scope that has been missing for a long while, the server runs the arr's search for exactly those
     * again (no new request, nothing charged, no OK needed) and says what it found. Resolves null when
     * that doesn't apply (nothing was sent for it yet, it isn't missing for long enough, or the caller
     * may not): the caller then asks for it instead, as before. An answer that came after the Search's owner ended (or
     * after another account signed in) never resolves null: it starts no ask (state 'skipped', `stale`).
     * @param {string} key Title key in scope (a movie key, or a series key, alone or ending :sN or :sN:eN).
     * @param {{expect?: Object, bound?: Object}} [options] What a season page's control was drawn to do (the server works it
     * out again: a refusal is state 'changed' or 'unchecked', never "ask instead"); bound: the operation's transport binding
     * (as {@link adminSearch}).
     * @returns {Promise<{ok: boolean, state: string, chip: string, text: string, tone: string, reason?: string}|null>} Result, or null to ask instead.
     */
    async function familySearch(key, options) {
        const k = String(key || '');
        if (!(k.startsWith('movie:') ? !/:s\d+/.test(k) : /^tv:[^:]+:[^:]+(:s\d+(:e\d+)?)?$/.test(k))) return null;
        let answer;
        let accepted = false;
        let sessionChanged = false;
        try {
            answer = await call('/acquire/requests/search', { method: 'POST', body: options?.expect ? { key: k, idempotencyKey: newClientId(), expect: options.expect } : { key: k, idempotencyKey: newClientId() }, bound: options?.bound });
        } catch (err) {
            // As adminSearch (D46S2-R11-9, R13-5, R13-6). Nothing went out (no answer and never sent): ask instead, as
            // before; sent with its answer lost: a failure to report, never a new ask for what may have run.
            const written = searchOutcome(err);
            if (written.outcome === 'accepted') { answer = written.answer || { status: 0, body: null }; accepted = true; sessionChanged = written.sessionChanged; }
            else if (written.outcome === 'unsent' && err?.name === 'AbortError') throw err;
            else if (written.sent) return { ok: false, state: 'failed', chip: '', text: tr('arr_search_failed_family'), tone: 'attention', sent: true };
            else return null;
        }
        const body = answer.body || {};
        let result;
        if (answer.status === 409 && (body.reason === 'press_changed' || body.reason === 'press_unverified')) {
            result = { ok: false, state: body.reason === 'press_changed' ? 'changed' : 'unchecked', reason: body.reason, chip: '', text: tr(body.reason === 'press_changed' ? 'arr_ask_changed' : 'arr_ask_check_failed'), tone: 'attention' };
        } else if (answer.status === 429 && body.reason === 'searched_recently') {
            result = { ok: false, state: 'recent', chip: tr('arr_search_recent_chip'), text: tr('arr_search_recent'), tone: 'looking' };
        } else if (answer.status === 403 && body.reason === 'low_disk') {
            // The drive its folder is on is full: the download couldn't be imported, and an ask would be refused too.
            result = { ok: false, state: 'blocked', reason: 'low_disk', chip: tr('arr_ask_paused_storage'), text: tr('arr_ask_toast_storage'), tone: 'attention' };
        } else if (answer.status >= 500) {
            result = { ok: false, state: 'failed', chip: '', text: tr('arr_search_failed_family'), tone: 'attention' };
        } else if (answer.status !== 200 || body.outcome === 'skipped') {
            // Nothing to search for it: the caller asks instead — only for a current owner.
            if (!accepted) return null;
            result = { ok: false, state: 'skipped', chip: '', text: '', tone: '' };
        } else if (body.found === true) {
            result = { ok: true, state: 'found', chip: tr('arr_search_found_chip'), text: tr('arr_search_found'), tone: 'downloading' };
        } else if (body.found === false) {
            result = { ok: true, state: 'nothing', chip: tr('arr_search_nothing_chip'), text: tr('arr_search_nothing'), tone: 'notHere' };
        } else {
            result = { ok: true, state: 'running', chip: tr('arr_search_running_chip'), text: tr('arr_search_running'), tone: 'looking' };
        }
        return searched(result, k, accepted, sessionChanged);
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

    /**
     * How a season's episodes line up between the provider whose facts its page shows (TMDB) and the destination a request
     * names them at by number: the server's verdict on its season rows (SeasonRows.numbering; matched on titles, the air day
     * only breaking ties). States: `agree`, `conflict`, `provider` (the request names TMDB's numbering: no arr holds the
     * series yet, or Seerr takes it), `destination` (TMDB's season couldn't be read) and `unknown` (not worked out, or the
     * rows couldn't be read at all).
     * @param {Object|null|undefined} rows The season rows ({numbering: {state, destinationOnly}}).
     * @returns {{state: string, destinationOnly: Array<number>}} Numbering.
     */
    function episodeNumbering(rows) {
        const verdict = rows?.numbering;
        const state = ['agree', 'conflict', 'provider', 'destination', 'unknown'].includes(verdict?.state) ? verdict.state : 'unknown';
        return { state, destinationOnly: Array.isArray(verdict?.destinationOnly) ? verdict.destinationOnly.filter(Number.isInteger) : [] };
    }

    /**
     * True when single episodes described by TMDB may be asked for by number under a numbering: only when they are known
     * to be the destination's episodes of those numbers (`agree`), or the request names TMDB's numbers itself
     * (`provider`). Anything not established, a failed read included, holds them (whole seasons stay askable).
     * @param {{state: string}|null|undefined} numbering Numbering ({@link episodeNumbering}).
     * @returns {boolean} Askable.
     */
    function episodeNumbersAskable(numbering) {
        return numbering?.state === 'agree' || numbering?.state === 'provider';
    }

    JE.session?.onUserChange?.('arr-ask', () => {
        meState = null;
        openIds.clear();
        checks.clear();
    });
    // The person's access moved (the server's access revision, core/access-revision.js): what they may ask for and the
    // title checks were worked out for the old access (a read in flight is dropped too: its state is no longer meState).
    document.addEventListener('je-access-revision', () => {
        meState = null;
        checks.clear();
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
        announce,
        canAsk,
        onChange,
        fingerprint,
        newClientId,
        movieInput,
        seasonsInput,
        episodesInput,
        seasonsOnly,
        wholeSeriesOnly,
        singleSeasonOnly,
        roundedLabel,
        seasonsLabel,
        roundedNote,
        roundedInput,
        wholeSeriesInput,
        seriesKey,
        searchInstance,
        searchAsksFirst,
        blockWords,
        pausedNote,
        paused,
        check,
        adminSearch,
        familySearch,
        tmdbSeasons,
        episodeNumbering,
        episodeNumbersAskable,
        call,
        tr
    });
})(window.JellyfinEnhanced);
