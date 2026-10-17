/**
 * @file Requests & downloads, phase 1: the shared status language on the client. Fetches statuses
 * from /JellyfinEnhanced/acquire/status (batched) and /acquire/status/item/{id}, turns a status
 * (stage + reason code + parameters) into the family sentence (en.json strings), builds the pill,
 * journey strip, admin explanation lines, poster badges and episode chips, and keeps a registry of
 * the elements on screen by title key so a later change event can refresh them in place
 * (JE.arrStatus.refresh(keys) / JE.arrStatus.subscribe(keys, cb)).
 * Everything text-like goes in through textContent; the server never sends HTML.
 */
(function (JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Status:';
    /** Longest wait for the change feed's first position before the first status read. */
    const PRIME_WAIT_MS = 1500;
    const STAGE_ICONS = {
        asked: 'hourglass_empty',
        approved: 'thumb_up',
        notOut: 'event',
        looking: 'search',
        downloading: 'download',
        almostReady: 'hourglass_bottom',
        ready: 'play_circle',
        notHere: 'remove_circle_outline',
        none: 'help_outline'
    };
    const JOURNEY_LABELS = {
        asked: 'arr_journey_asked',
        approved: 'arr_journey_approved',
        notOut: 'arr_journey_not_out',
        looking: 'arr_journey_looking',
        downloading: 'arr_journey_downloading',
        almostReady: 'arr_journey_almost',
        ready: 'arr_journey_ready'
    };

    /** @type {Map<string, Set<Function>>} key -> refresh callbacks of surfaces showing it */
    const subscribers = new Map();
    let disabled = false;
    /** The stamps route answered 403 (feature_disabled) in this page load (phase 4e). */
    let stampsDisabled = false;
    /**
     * Acquisition stamp chips (phase 4e): icon, short word and title per stamp. The fiber_new and 4k
     * glyphs spell their word themselves; only Upgraded's arrow gets one.
     */
    const STAMPS = {
        upgraded: { icon: 'upgrade', word: 'arr_badge_upgraded', title: 'arr_badge_upgraded_title' },
        new: { icon: 'fiber_new', word: null, title: 'arr_badge_new_title' },
        fourK: { icon: '4k', word: null, title: 'arr_badge_fourk_title' }
    };

    /**
     * Translates a key with {name} parameters.
     * @param {string} key en.json key.
     * @param {Object<string, string|number>} [params] Parameters.
     * @returns {string} The text.
     */
    function tr(key, params) {
        const out = typeof JE.t === 'function' ? JE.t(key, params) : key;
        if (typeof out !== 'string') return key;
        // JE.t substitutes known parameters; make sure none is left raw.
        return params ? Object.entries(params).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), out) : out;
    }

    /**
     * True when the server has the status feature on (master switch and phase 1).
     * @returns {boolean} Enabled.
     */
    function enabled() {
        return !disabled && JE?.pluginConfig?.ArrStatusEnabled === true;
    }

    /**
     * The change-feed position to hand to subscriptions made after a status read (the read can't
     * miss a change made after it). Waits, once per tab and at most PRIME_WAIT_MS, for the feed to
     * have a position; null without the live module.
     * @returns {Promise<{epoch: string, cursor: number}|null>} The position.
     */
    async function feedPosition() {
        const live = JE.arr?.live;
        if (!live || typeof live.position !== 'function') return null;
        const known = live.position();
        if (known || typeof live.prime !== 'function') return known;
        let timer = null;
        try {
            return await Promise.race([
                live.prime(),
                new Promise(resolve => { timer = setTimeout(() => resolve(null), PRIME_WAIT_MS); })
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * GET a status route. A 403 feature_disabled switches the module off for this page load.
     * The answer carries `since`: the change-feed position from before the read, for
     * {@link subscribe}.
     * @param {string} path Path under /JellyfinEnhanced.
     * @param {{priority?: 'low', signal?: AbortSignal}} [options] Fetch options.
     * @returns {Promise<{contact: string, lookingHours: number, items: Array<Object>, since?: {epoch: string, cursor: number}|null}|null>} The response, or null.
     */
    async function get(path, options) {
        if (!enabled()) return null;
        const since = await feedPosition();
        const data = await read(path, options);
        if (data && typeof data === 'object') data.since = since;
        return data;
    }

    /**
     * The request behind {@link get}.
     * @param {string} path Path under /JellyfinEnhanced.
     * @param {{priority?: 'low', signal?: AbortSignal}} [options] Fetch options.
     * @returns {Promise<Object|null>} The response, or null.
     */
    async function read(path, options) {
        if (!enabled()) return null;
        try {
            return await send(path, options);
        } catch (err) {
            if (err?.name === 'AbortError') return null;
            if (err?.status === 403) disabled = true;
            console.warn(`${logPrefix} status request failed (${err?.status || err?.message || err})`);
            return null;
        }
    }

    /**
     * The transport behind {@link read} and {@link fetchStamps}: JE.core.api.plugin when present,
     * else a plain authorized fetch. Throws on failure (the HTTP status on `err.status`).
     * @param {string} path Path under /JellyfinEnhanced.
     * @param {{priority?: 'low', signal?: AbortSignal}} [options] Fetch options.
     * @returns {Promise<Object>} The response.
     */
    async function send(path, options) {
        const api = JE.core?.api;
        if (api?.plugin) {
            return await api.plugin(path, { priority: options?.priority, signal: options?.signal, skipRetry: true });
        }
        const response = await fetch(ApiClient.getUrl(`/JellyfinEnhanced${path}`), {
            headers: { 'Authorization': `MediaBrowser Token="${ApiClient.accessToken()}"`, 'Accept': 'application/json' },
            signal: options?.signal
        });
        if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
        return await response.json();
    }

    // ------------------------------------------------------------------ acquisition stamps (phase 4e)

    /**
     * True when poster cards may show acquisition badges (Upgraded / New for you / 4K): the
     * administrator turned them on, this person didn't hide them in their own settings, and the
     * stamps route didn't answer feature_disabled during this page load.
     * @returns {boolean} Enabled.
     */
    function stampsEnabled() {
        if (stampsDisabled || JE?.pluginConfig?.ArrAcquisitionBadgesEnabled !== true) return false;
        const own = JE.currentSettings?.acquisitionBadges ?? JE.userConfig?.settings?.acquisitionBadges;
        return own !== false;
    }

    /**
     * The acquisition stamps of many items at once (poster cards), low priority. Only items that
     * have a stamp come back. A 403 (feature_disabled) switches stamps off for this page load
     * without touching the status routes.
     * @param {string[]} ids Jellyfin item ids (≤ 100).
     * @param {AbortSignal} [signal] Abort signal.
     * @returns {Promise<{items: Array<{itemId: string, stamp: string}>}|null>} The response, or null on failure.
     */
    async function fetchStamps(ids, signal) {
        if (!stampsEnabled()) return null;
        // Titles that aren't in the library have no stamp (same rule as fetchBatch).
        if (ids?.length && JE.titleDetails?.isSynthetic) ids = ids.filter(id => !JE.titleDetails.isSynthetic(id));
        if (!ids?.length) return { items: [] };
        try {
            const data = await send(`/acquire/stamps?ids=${ids.map(encodeURIComponent).join(',')}`, { priority: 'low', signal });
            return data && typeof data === 'object' ? data : null;
        } catch (err) {
            if (err?.name === 'AbortError') return null;
            if (err?.status === 403) stampsDisabled = true;
            console.warn(`${logPrefix} stamps request failed (${err?.status || err?.message || err})`);
            return null;
        }
    }

    /**
     * Full status of one Jellyfin item (details pages).
     * @param {string} itemId Item id.
     * @param {AbortSignal} [signal] Abort signal.
     * @returns {Promise<Object|null>} The response.
     */
    function fetchItem(itemId, signal) {
        return get(`/acquire/status/item/${encodeURIComponent(itemId)}`, { signal });
    }

    /**
     * Statuses of many items/keys at once (poster cards), low priority.
     * @param {string[]} ids Jellyfin item ids (≤ 100).
     * @param {string[]} [keys] Title keys (≤ 50).
     * @param {AbortSignal} [signal] Abort signal.
     * @returns {Promise<Object|null>} The response.
     */
    function fetchBatch(ids, keys, signal) {
        // Titles that aren't in the library (native details pages) have no item status; their page
        // reads its status by title key instead.
        if (ids?.length && JE.titleDetails?.isSynthetic) ids = ids.filter(id => !JE.titleDetails.isSynthetic(id));
        if (!ids?.length && !keys?.length) return Promise.resolve({ items: [] });
        const q = [];
        if (ids?.length) q.push(`ids=${ids.map(encodeURIComponent).join(',')}`);
        if (keys?.length) q.push(`keys=${keys.map(encodeURIComponent).join(',')}`);
        return get(`/acquire/status?${q.join('&')}`, { priority: 'low', signal });
    }

    /**
     * Status of one title by key, with a movie's journey (a page about a title that may not be in
     * Jellyfin yet: the Seerr more-info modal).
     * @param {string} key Movie or series key.
     * @param {AbortSignal} [signal] Abort signal.
     * @returns {Promise<Object|null>} The response.
     */
    function fetchKey(key, signal) {
        return get(`/acquire/status?keys=${encodeURIComponent(key)}&detail=true`, { signal });
    }

    // ------------------------------------------------------------------ formatting

    /**
     * A date from the server: a bare calendar day ("2026-11-14", a release date with no time) is that
     * day where the viewer is (read as UTC midnight it would be a day early west of UTC); anything
     * else is an instant.
     * @param {string} iso ISO date or "yyyy-MM-dd".
     * @returns {Date|null} The date, or null when invalid.
     */
    function parseDate(iso) {
        if (!iso) return null;
        const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
        if (day) {
            const [year, month, date] = [Number(day[1]), Number(day[2]) - 1, Number(day[3])];
            const d = new Date(year, month, date);
            // Out-of-range parts would otherwise roll over into another date.
            return d.getFullYear() === year && d.getMonth() === month && d.getDate() === date ? d : null;
        }
        const d = new Date(iso);
        return isNaN(d.getTime()) ? null : d;
    }

    /**
     * True when a bare calendar day ("yyyy-MM-dd") is before the viewer's today.
     * @param {string} day The day.
     * @returns {boolean} Past.
     */
    function dayPassed(day) {
        const d = parseDate(day);
        if (!d) return false;
        const now = new Date();
        return d.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    }

    /**
     * A date as the family reads it: "today", "tomorrow", a weekday within the week, else "14 Nov".
     * @param {string} iso ISO date, or a bare calendar day "yyyy-MM-dd".
     * @returns {string} The date text ('' when invalid).
     */
    function formatDate(iso) {
        const d = parseDate(iso);
        if (!d) return '';
        const now = new Date();
        const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const days = Math.round((startOf(d) - startOf(now)) / 86400000);
        if (days === 0) return tr('arr_date_today');
        if (days === 1) return tr('arr_date_tomorrow');
        if (days === -1) return tr('arr_date_yesterday');
        if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
        if (days < 0 && days > -7) return d.toLocaleDateString(undefined, { weekday: 'short' });
        const sameYear = d.getFullYear() === now.getFullYear();
        return d.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
    }

    /**
     * True when a date-only air day is already behind the viewer's local day. The server keeps an
     * episode "not out" for a while after its air day (time zones), so for some viewers that day has
     * passed: the text then says it aired rather than "Airs yesterday".
     * @param {string} iso Air day.
     * @returns {boolean}
     */
    function dayPassed(iso) {
        const d = parseDate(iso);
        if (!d) return false;
        const now = new Date();
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    }

    /**
     * "about 12 min" / "about 2 h" / "less than a minute".
     * @param {number|null|undefined} seconds Seconds left.
     * @returns {string} Text ('' when unknown).
     */
    function formatEta(seconds) {
        if (typeof seconds !== 'number' || !(seconds > 0)) return '';
        if (seconds < 60) return tr('arr_eta_soon');
        if (seconds < 5400) return tr('arr_eta_minutes', { n: Math.max(1, Math.round(seconds / 60)) });
        return tr('arr_eta_hours', { n: Math.round(seconds / 3600) });
    }

    /**
     * The household contact for texts ("Dad"), or the neutral word.
     * @param {{contact?: string}} ctx Response context.
     * @returns {string} Contact.
     */
    function contactOf(ctx) {
        return (ctx?.contact || '').trim() || tr('arr_contact_default');
    }

    /**
     * True when a title (or episode) is monitored, out and still has no copy long after it was
     * wanted (nothing grabbed for longer than LookingHours, reason no_release_yet): it is shown as
     * plainly Missing with a Search button instead of "still looking" with a journey.
     * @param {Object} status Status or episode status.
     * @returns {boolean} Searchable.
     */
    function searchable(status) {
        return status?.reason?.code === 'no_release_yet' && status?.stage === 'looking' && !status?.attention;
    }

    /**
     * The family sentence for a status (or an episode status).
     * @param {Object} status Status from the server.
     * @param {Object} ctx Response context (contact).
     * @returns {string} Text.
     */
    function familyText(status, ctx) {
        const reason = status?.reason || {};
        const p = reason.params || {};
        const date = p.date ? formatDate(p.date) : '';
        const contact = contactOf(ctx);
        switch (reason.code) {
            // Held back at sending (admins only are told): it waits for them, not for an OK.
            case 'awaiting_approval': return p.held ? tr('arr_status_held') : tr('arr_status_awaiting_approval', { contact });
            case 'approved': return tr('arr_status_approved');
            case 'declined': return tr('arr_status_declined', { contact });
            case 'not_released': return date ? tr('arr_status_not_released_date', { date }) : tr('arr_status_not_released');
            case 'in_cinemas': return date ? tr('arr_status_in_cinemas_date', { date }) : tr('arr_status_in_cinemas');
            case 'not_aired': return date ? tr(dayPassed(p.date) ? 'arr_status_aired_date' : 'arr_status_not_aired_date', { date }) : tr('arr_status_not_aired');
            case 'looking': return tr('arr_status_looking');
            case 'no_release_yet': return tr('arr_status_no_release_yet');
            case 'queued':
            case 'delay_held': return tr('arr_status_queued');
            case 'downloading': {
                const pct = status.progress?.percent;
                const eta = formatEta(status.progress?.etaSeconds);
                if (typeof pct !== 'number') return tr('arr_status_downloading');
                return eta ? tr('arr_status_downloading_eta', { pct, eta }) : tr('arr_status_downloading_pct', { pct });
            }
            case 'stalled': return tr('arr_status_stalled');
            case 'failed': return tr('arr_status_failed');
            case 'importing':
            case 'library_pending': return tr('arr_status_almost_ready');
            case 'import_blocked':
            case 'client_unavailable':
            case 'approved_not_in_arr':
            case 'service_down': return tr('arr_status_taking_longer');
            case 'upgrading': return tr('arr_status_upgrading');
            case 'unmonitored': return tr('arr_status_unmonitored');
            case 'partial': return tr('arr_status_partial');
            case 'not_in_arr':
            case 'not_visible_to_user': return tr('arr_status_not_here');
            case 'removed': return tr('arr_status_removed');
            case 'ready': return status?.stage === 'ready' ? tr('arr_status_ready') : stageText(status, contact);
            default: return stageText(status, contact);
        }
    }

    /**
     * The family sentence of a stage alone, for a reason code this client doesn't know (a newer
     * server): never "Ready to watch" unless the stage is ready.
     * @param {Object} status Status from the server.
     * @param {string} contact The household contact.
     * @returns {string} Text.
     */
    function stageText(status, contact) {
        switch (status?.stage) {
            case 'asked': return tr('arr_status_awaiting_approval', { contact });
            case 'approved': return tr('arr_status_approved');
            case 'notOut': return tr('arr_status_not_released');
            case 'looking': return tr('arr_status_looking');
            case 'downloading': return tr('arr_status_downloading');
            case 'almostReady': return tr('arr_status_almost_ready');
            case 'ready': return tr('arr_status_ready');
            case 'notHere': return tr('arr_status_not_here');
            default: return tr('arr_status_unknown');
        }
    }

    /**
     * Summary pieces for a series or season ("Seasons 1–2 ready", "Season 3 airing (ep 6 Fri)",
     * "1 downloading", "8 of 10 ready", ...).
     * @param {Object} status Series or season status.
     * @returns {Array<{text: string, tone: string, icon: string}>} Pieces in display order.
     */
    function summaryPieces(status) {
        const s = status?.summary;
        if (!s) return [];
        const pieces = [];
        if (status.kind === 'series') {
            const seasons = s.readySeasons || [];
            if (seasons.length) pieces.push({ text: seasonRangeText(seasons), tone: 'ready', icon: 'check_circle' });
        } else if (s.aired > 0 && s.ready < s.aired) {
            pieces.push({ text: tr('arr_summary_x_of_y_ready', { ready: s.ready, aired: s.aired }), tone: 'ready', icon: 'check_circle' });
        } else if (s.aired > 0) {
            pieces.push({ text: tr('arr_summary_all_ready'), tone: 'ready', icon: 'check_circle' });
        }
        if (s.nextAir) {
            const date = formatDate(status.nextDay || s.nextAir);
            let text;
            if (status.kind === 'series' && s.nextSeason != null && s.nextEpisode != null) {
                text = s.nextEpisode > 1
                    ? tr('arr_summary_season_airing', { season: s.nextSeason, episode: s.nextEpisode, date })
                    : tr('arr_summary_season_starts', { season: s.nextSeason, date });
            } else if (s.nextEpisode != null) {
                text = tr('arr_summary_episode_airs', { episode: s.nextEpisode, date });
            } else {
                text = tr('arr_summary_next_airs', { date });
            }
            pieces.push({ text, tone: 'notOut', icon: 'event' });
        }
        if (s.downloading > 0) pieces.push({ text: tr('arr_summary_downloading', { n: s.downloading }), tone: 'downloading', icon: 'download' });
        if (s.almostReady > 0) pieces.push({ text: tr('arr_summary_almost_ready', { n: s.almostReady }), tone: 'almostReady', icon: 'hourglass_bottom' });
        const missing = s.missing || 0;
        const unknown = s.unknown == null && status.reason?.code === 'service_down' ? missing : Math.min(missing, s.unknown || 0);
        // Missing for a long while (Search) apart from the ones the arr is looking for right now (a server that doesn't
        // say counts every one as missing, as before).
        const known = missing - unknown;
        const long = typeof s.longMissing === 'number' ? Math.min(known, Math.max(0, s.longMissing)) : known;
        if (known - long > 0) pieces.push({ text: tr('arr_summary_looking', { n: known - long }), tone: 'looking', icon: 'search' });
        if (long > 0) pieces.push({ text: tr('arr_summary_missing', { n: long }), tone: 'looking', icon: 'search' });
        const attention = (s.attention || 0) + unknown;
        if (attention > 0) pieces.push({ text: tr('arr_summary_attention', { n: attention }), tone: 'attention', icon: 'schedule' });
        return pieces;
    }

    /**
     * "Season 2 ready" / "Seasons 1–3 ready" / "Seasons 1, 3 ready".
     * @param {number[]} seasons Ready season numbers.
     * @returns {string} Text.
     */
    function seasonRangeText(seasons) {
        const sorted = [...seasons].sort((a, b) => a - b);
        if (sorted.length === 1) return tr('arr_summary_season_ready', { season: sorted[0] });
        const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
        const range = contiguous ? `${sorted[0]}–${sorted[sorted.length - 1]}` : sorted.join(', ');
        return tr('arr_summary_seasons_ready', { range });
    }

    /**
     * The short chip text for an episode row or banner entry.
     * @param {Object} ep Episode status.
     * @returns {string} Text.
     */
    function chipText(ep) {
        const code = ep?.reason?.code;
        if (ep.stage === 'ready') return code === 'upgrading' ? tr('arr_chip_upgrading') : tr('arr_chip_ready');
        if (ep.stage === 'downloading') {
            if (code === 'queued' || code === 'delay_held') return tr('arr_chip_queued');
            if (code === 'stalled' || code === 'client_unavailable') return tr('arr_chip_taking_longer');
            const pct = ep.progress?.percent;
            return typeof pct === 'number' ? tr('arr_chip_downloading_pct', { pct }) : tr('arr_chip_downloading');
        }
        if (ep.stage === 'almostReady') return code === 'import_blocked' ? tr('arr_chip_taking_longer') : tr('arr_chip_almost_ready');
        if (ep.stage === 'notOut') {
            const date = ep.reason?.params?.date || ep.airDate;
            return date ? tr(dayPassed(date) ? 'arr_chip_aired' : 'arr_chip_airs', { date: formatDate(date) }) : tr('arr_chip_not_aired');
        }
        if (ep.stage === 'asked') return ep.reason?.params?.held ? tr('arr_chip_held') : tr('arr_chip_waiting_ok');
        if (code === 'failed' || code === 'service_down') return tr('arr_chip_taking_longer');
        if (code === 'unmonitored') return tr('arr_chip_not_fetched');
        // Monitored and wanted a moment ago: the arr is on it (missing for a long while reads Missing).
        if (ep.stage === 'looking' && !searchable(ep)) return tr('arr_chip_looking');
        return tr('arr_chip_missing');
    }

    /**
     * Admin explanation lines: one per copy (instance) that is not simply ready, with the arr's
     * own words and the fix hint. Only present when the server sent the admin block.
     * @param {Object} status Status.
     * @returns {Array<{text: string, detail: string, fix: string, attention: boolean}>} Lines.
     */
    function adminLines(status) {
        const admin = status?.admin;
        if (!admin) return [];
        const lines = [];
        const multi = (admin.variants || []).filter(v => !v.scope).length > 1;
        for (const v of admin.variants || []) {
            if (!multi && !v.scope && v.stage === 'ready' && v.reason?.code === 'ready' && !v.attention) continue;
            const label = v.scope ? `${v.scope} · ${v.instance}` : v.instance;
            const parts = [label, adminReasonText(v)];
            if (v.since && (v.attention || v.stage !== 'ready')) parts.push(sinceText(v.since));
            if (v.lastSearch && v.stage === 'looking') {
                const age = ageText(v.lastSearch);
                parts.push(age ? tr('arr_admin_last_searched', { age }) : tr('arr_admin_last_searched_now'));
            }
            if (v.client) parts.push(v.client);
            if (v.quality) parts.push(v.quality + (typeof v.customFormatScore === 'number' ? ` · CF ${v.customFormatScore}` : ''));
            lines.push({
                text: parts.filter(Boolean).join(' · '),
                detail: (v.messages || []).join(' — '),
                fix: v.fix ? tr(`arr_fix_${v.fix}`, { instance: v.instance, library: v.library || '' }) : '',
                attention: !!v.attention
            });
        }
        for (const name of admin.unreadable || []) {
            lines.push({ text: tr('arr_admin_unreadable', { instance: name }), detail: '', fix: tr('arr_fix_health', { instance: name }), attention: true });
        }
        if (admin.approvedNotInArrSince) {
            // Phase 2: Seerr OK'd it a while ago, yet no Sonarr/Radarr has the title.
            const key = !admin.approvedNotIn4k ? 'arr_admin_approved_not_in_arr' : status.kind === 'movie' ? 'arr_admin_approved_not_in_4k' : 'arr_admin_approved_not_in_4k_series';
            lines.push({ text: tr(key, { age: ageText(admin.approvedNotInArrSince) }), detail: '', fix: tr('arr_fix_check_seerr'), attention: true });
        }
        return lines;
    }

    /**
     * How long ago a moment was, in short words ("20 min", "3 h", "2 d").
     * @param {string} iso ISO date.
     * @returns {string} Text ('' for a future or invalid date).
     */
    function ageText(iso) {
        const ms = Date.now() - new Date(iso).getTime();
        if (!(ms >= 0)) return '';
        if (ms < 3600000) return tr('arr_duration_minutes', { n: Math.max(1, Math.round(ms / 60000)) });
        if (ms < 86400000) return tr('arr_duration_hours', { n: Math.round(ms / 3600000) });
        return tr('arr_duration_days', { n: Math.round(ms / 86400000) });
    }

    /**
     * "for 41 min" / "for 3 h" within a day, else "since Tue".
     * @param {string} iso ISO date.
     * @returns {string} Text.
     */
    function sinceText(iso) {
        const ms = Date.now() - new Date(iso).getTime();
        if (!(ms >= 0)) return '';
        if (ms < 3600000) return tr('arr_admin_for', { duration: tr('arr_duration_minutes', { n: Math.max(1, Math.round(ms / 60000)) }) });
        if (ms < 86400000) return tr('arr_admin_for', { duration: tr('arr_duration_hours', { n: Math.round(ms / 3600000) }) });
        return tr('arr_admin_since', { date: formatDate(iso) });
    }

    /**
     * The admin wording for one copy's reason (instance terms allowed).
     * @param {Object} v Admin variant.
     * @returns {string} Text.
     */
    function adminReasonText(v) {
        const code = v.reason?.code;
        const params = { instance: v.instance, library: v.library || '', min: v.minimumAvailability || '?' };
        switch (code) {
            case 'downloading': return v.progress ? tr('arr_admin_downloading_pct', { pct: v.progress.percent }) : tr('arr_admin_downloading');
            case 'ready': return v.library ? tr('arr_admin_ready_in', params) : tr('arr_admin_ready');
            case 'upgrading': return tr('arr_admin_upgrading');
            default: return tr(`arr_admin_${code || 'ready'}`, params);
        }
    }

    // ------------------------------------------------------------------ failed re-reads

    /** First and longest wait before a failed re-read is tried again (data stays on screen meanwhile). */
    const RETRY_FIRST_MS = 5000;
    const RETRY_MAX_MS = 60000;

    /**
     * The wait before the next try after a failed re-read: 5 s, then twice as long, at most a minute.
     * @param {number} [previous] The wait before the last try (0 or none: the first).
     * @returns {number} Milliseconds.
     */
    function retryDelay(previous) {
        return Math.min(RETRY_MAX_MS, previous > 0 ? previous * 2 : RETRY_FIRST_MS);
    }

    /**
     * The note shown while a re-read failed and the page still shows what it had: "Couldn't
     * refresh · showing what we had at {time}" and a Retry button (role=status: read out once).
     * @param {number} okAt When the data on screen was read (ms since epoch; 0: unknown).
     * @param {Function} onRetry Called when Retry is pressed.
     * @param {string} [cls] Extra class names.
     * @returns {HTMLElement} Note.
     */
    function staleNote(okAt, onRetry, cls) {
        const note = el('div', `je-arr-stale-note${cls ? ' ' + cls : ''}`);
        note.setAttribute('role', 'status');
        const time = okAt ? new Date(okAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
        note.appendChild(el('span', 'je-arr-stale-text', tr('arr_hub_refresh_failed', { time })));
        const retry = el('button', 'je-arr-stale-retry', tr('arr_hub_retry'));
        retry.type = 'button';
        retry.dataset.jeFocus = 'stale-retry';
        retry.addEventListener('click', () => onRetry());
        note.appendChild(retry);
        return note;
    }

    // ------------------------------------------------------------------ DOM builders

    /**
     * Creates an element with a class and optional text.
     * @param {string} tag Tag.
     * @param {string} [cls] Class names.
     * @param {string} [text] Text content.
     * @returns {HTMLElement} Element.
     */
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    /**
     * A material icon span.
     * @param {string} name Icon name.
     * @param {string} [cls] Extra class.
     * @returns {HTMLElement} Span.
     */
    function icon(name, cls) {
        const s = el('span', `material-icons${cls ? ' ' + cls : ''}`, name);
        s.setAttribute('aria-hidden', 'true');
        return s;
    }

    /**
     * The tone (colour) of a status: attention, downloading, ...
     * @param {Object} status Status.
     * @returns {string} Tone.
     */
    function toneOf(status) {
        if (status?.attention) return 'attention';
        if (searchable(status)) return 'notHere';
        return status?.stage || 'none';
    }

    /**
     * The pill: icon + family sentence, optional progress bar and an expandable journey strip.
     * Colour is never the only signal (icon and text always present).
     * @param {Object} status Movie or episode status.
     * @param {Object} ctx Response context.
     * @returns {HTMLElement} The status block.
     */
    function buildPill(status, ctx) {
        const block = el('div', 'je-arr-status');
        block.dataset.jeArrKey = status.key || '';
        const tone = toneOf(status);
        // Missing for a long while: no journey (it would promise steps nothing is taking).
        const hasJourney = Array.isArray(status.journey) && status.journey.length > 1 && !searchable(status);
        const pill = el(hasJourney ? 'button' : 'div', `je-arr-pill je-arr-tone-${tone}`);
        if (hasJourney) {
            pill.type = 'button';
            pill.setAttribute('aria-expanded', 'false');
        }
        pill.appendChild(icon(status.attention ? 'schedule' : (STAGE_ICONS[toneOf(status)] || STAGE_ICONS[status.stage] || 'info'), 'je-arr-pill-icon'));
        pill.appendChild(el('span', 'je-arr-pill-text', familyText(status, ctx)));
        if (hasJourney) pill.appendChild(icon('expand_more', 'je-arr-pill-caret'));
        block.appendChild(pill);
        if (status.stage === 'downloading' && typeof status.progress?.percent === 'number') {
            const bar = el('div', 'je-arr-progress');
            bar.setAttribute('role', 'progressbar');
            bar.setAttribute('aria-valuemin', '0');
            bar.setAttribute('aria-valuemax', '100');
            bar.setAttribute('aria-valuenow', String(status.progress.percent));
            const fill = el('div', 'je-arr-progress-fill');
            fill.style.width = `${Math.max(0, Math.min(100, status.progress.percent))}%`;
            bar.appendChild(fill);
            block.appendChild(bar);
        }
        if (hasJourney) {
            const journey = buildJourney(status.journey);
            journey.hidden = true;
            block.appendChild(journey);
            pill.addEventListener('click', () => {
                const open = journey.hidden;
                journey.hidden = !open;
                pill.setAttribute('aria-expanded', String(open));
                block.classList.toggle('je-arr-open', open);
            });
        }
        appendAdmin(block, status);
        return block;
    }

    /**
     * The series/season summary row: small pills with icons, plus admin lines.
     * @param {Object} status Series or season status.
     * @returns {HTMLElement|null} Block, or null when there is nothing to say.
     */
    function buildSummary(status) {
        const pieces = summaryPieces(status);
        const lines = adminLines(status);
        if (!pieces.length && !lines.length) return null;
        const block = el('div', 'je-arr-status je-arr-summary');
        block.dataset.jeArrKey = status.key || '';
        const row = el('div', 'je-arr-summary-row');
        for (const piece of pieces) {
            const pill = el('div', `je-arr-pill je-arr-pill-small je-arr-tone-${piece.tone}`);
            pill.appendChild(icon(piece.icon, 'je-arr-pill-icon'));
            pill.appendChild(el('span', 'je-arr-pill-text', piece.text));
            row.appendChild(pill);
        }
        if (pieces.length) block.appendChild(row);
        appendAdmin(block, status);
        return block;
    }

    /**
     * The journey strip: dated dots for the stops that happened, the current one, then what is to come.
     * @param {Array<{stage: string, at?: string, state: string, byYou?: boolean}>} stops Stops.
     * @returns {HTMLElement} Strip.
     */
    function buildJourney(stops) {
        const list = el('ol', 'je-arr-journey');
        for (const stop of stops) {
            const li = el('li', `je-arr-stop je-arr-stop-${stop.state}`);
            li.appendChild(el('span', 'je-arr-dot'));
            let label = tr(JOURNEY_LABELS[stop.stage] || 'arr_journey_ready');
            if (stop.stage === 'asked') label = stop.byYou === false ? tr('arr_journey_asked_household') : stop.byYou === true ? tr('arr_journey_asked_you') : label;
            li.appendChild(el('span', 'je-arr-stop-label', label));
            const when = stop.state === 'current' ? tr('arr_journey_now') : stop.at ? formatDate(stop.at) : '';
            if (when) li.appendChild(el('span', 'je-arr-stop-date', when));
            list.appendChild(li);
        }
        return list;
    }

    /**
     * Appends the admin explanation lines (if the server sent the admin block).
     * @param {HTMLElement} block Status block.
     * @param {Object} status Status.
     * @returns {void}
     */
    function appendAdmin(block, status) {
        const lines = adminLines(status);
        if (!lines.length) return;
        const box = el('div', 'je-arr-admin');
        for (const line of lines) {
            const row = el('div', `je-arr-admin-line${line.attention ? ' je-arr-admin-attention' : ''}`);
            row.appendChild(icon(line.attention ? 'report' : 'dns', 'je-arr-admin-icon'));
            const body = el('div', 'je-arr-admin-body');
            body.appendChild(el('div', 'je-arr-admin-text', line.text));
            if (line.detail) body.appendChild(el('div', 'je-arr-admin-detail', line.detail));
            if (line.fix) body.appendChild(el('div', 'je-arr-admin-fix', line.fix));
            row.appendChild(body);
            box.appendChild(row);
        }
        block.appendChild(box);
    }

    /**
     * A poster-card badge for a status, or null when there is nothing to show (quiet).
     * Attention > downloading ring > almost ready > the acquisition stamp (phase 4e: Upgraded,
     * New for you or 4K, as the server resolved it for this person); season cards also show ✓ or
     * "◐ ready/aired" first.
     * @param {Object|null} [status] Card status (null: none known; a stamp alone still draws).
     * @param {'upgraded'|'new'|'fourK'|null} [stamp] Acquisition stamp.
     * @returns {HTMLElement|null} Badge host content.
     */
    function buildBadge(status, stamp) {
        const chip = Object.prototype.hasOwnProperty.call(STAMPS, stamp) ? STAMPS[stamp] : null;
        if (!status && !chip) return null;
        status = status || {};
        const s = status.summary;
        const box = el('div', 'je-arr-badge');
        box.dataset.jeArrKey = status.key || '';
        let any = false;
        if (status.kind === 'season' && s && s.aired > 0) {
            if (s.ready >= s.aired && !s.missing) {
                const done = el('span', 'je-arr-badge-chip je-arr-tone-ready');
                done.appendChild(icon('check', 'je-arr-badge-icon'));
                done.title = tr('arr_summary_all_ready');
                box.appendChild(done);
                any = true;
            } else if (s.ready > 0 || s.missing > 0) {
                const part = el('span', 'je-arr-badge-chip je-arr-tone-partial', `◐ ${s.ready}/${s.aired}`);
                part.title = tr('arr_summary_x_of_y_ready', { ready: s.ready, aired: s.aired });
                box.appendChild(part);
                any = true;
            }
        }
        const downloading = status.stage === 'downloading' || (s && s.downloading > 0);
        if (status.attention) {
            const warn = el('span', 'je-arr-badge-chip je-arr-tone-attention');
            warn.appendChild(icon('schedule', 'je-arr-badge-icon'));
            warn.title = tr('arr_status_taking_longer');
            box.appendChild(warn);
            any = true;
        } else if (downloading) {
            box.appendChild(ring(status.progress?.percent));
            any = true;
        } else if (status.stage === 'almostReady' || (s && s.almostReady > 0)) {
            const almost = el('span', 'je-arr-badge-chip je-arr-tone-almostReady');
            almost.appendChild(icon('hourglass_bottom', 'je-arr-badge-icon'));
            almost.title = tr('arr_status_almost_ready');
            box.appendChild(almost);
            any = true;
        } else if (chip) {
            const mark = el('span', `je-arr-badge-chip je-arr-tone-${stamp} je-arr-badge-stamp`);
            mark.appendChild(icon(chip.icon, 'je-arr-badge-icon'));
            if (chip.word) mark.appendChild(el('span', 'je-arr-badge-word', tr(chip.word)));
            mark.title = tr(chip.title);
            box.appendChild(mark);
            any = true;
        }
        if (!any) return null;
        box.setAttribute('role', 'img');
        box.setAttribute('aria-label', [...box.querySelectorAll('[title]')].map(x => x.title).join(', '));
        return box;
    }

    /**
     * A download ring (SVG) with the percentage, or an indeterminate ring.
     * @param {number|undefined} pct Percent.
     * @returns {HTMLElement} Ring.
     */
    function ring(pct) {
        const wrap = el('span', 'je-arr-ring');
        const known = typeof pct === 'number';
        wrap.title = known ? tr('arr_chip_downloading_pct', { pct }) : tr('arr_chip_downloading');
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 36 36');
        svg.setAttribute('aria-hidden', 'true');
        const track = document.createElementNS(ns, 'circle');
        track.setAttribute('class', 'je-arr-ring-track');
        const bar = document.createElementNS(ns, 'circle');
        bar.setAttribute('class', 'je-arr-ring-bar');
        for (const c of [track, bar]) {
            c.setAttribute('cx', '18');
            c.setAttribute('cy', '18');
            c.setAttribute('r', '15');
        }
        const circumference = 2 * Math.PI * 15;
        const value = known ? Math.max(0, Math.min(100, pct)) : 25;
        bar.setAttribute('stroke-dasharray', `${(circumference * value / 100).toFixed(1)} ${circumference.toFixed(1)}`);
        svg.appendChild(track);
        svg.appendChild(bar);
        wrap.appendChild(svg);
        wrap.appendChild(el('span', 'je-arr-ring-text', known ? `${Math.round(value)}` : ''));
        if (!known) wrap.classList.add('je-arr-ring-busy');
        return wrap;
    }

    // ------------------------------------------------------------------ live refresh registry

    /**
     * Registers a surface's refresh callback for title keys. A change event for any of the keys
     * (from the change feed when present, or JE.arrStatus.refresh) calls it with the keys that changed.
     * @param {string[]} keys Title keys (season/episode keys refresh their series too).
     * @param {(keys: string[]) => void} callback Re-render callback.
     * @param {{since?: {epoch: string, cursor: number}|null}} [options] `since`: the `since` of the
     *   status answer the surface shows, so changes made after that read are delivered even if they
     *   happened before this subscription. `null` (the read had no feed position) gets one callback
     *   once the feed has a position, so the surface re-reads from there.
     * @returns {() => void} Unsubscribe.
     */
    function subscribe(keys, callback, options) {
        const list = [...new Set((keys || []).filter(Boolean))];
        for (const key of list) {
            if (!subscribers.has(key)) subscribers.set(key, new Set());
            subscribers.get(key).add(callback);
        }
        let external = null;
        if (typeof JE.arr?.onStatusChange === 'function') {
            try {
                // A season or episode surface also follows its series: Jellyfin announces a new
                // episode under its series before it knows the episode's numbers.
                const feedKeys = [...new Set(list.concat(list.map(key => key.replace(/:s\d+(:e\d+)?$/, ''))))];
                const since = options?.since ? { since: options.since } : options?.since === null ? { since: null } : undefined;
                external = JE.arr.onStatusChange(feedKeys, (changed) => callback(Array.isArray(changed) ? changed : list), since);
            } catch (err) {
                console.warn(`${logPrefix} change feed subscription failed`, err);
            }
        }
        return () => {
            for (const key of list) {
                const set = subscribers.get(key);
                if (set) {
                    set.delete(callback);
                    if (!set.size) subscribers.delete(key);
                }
            }
            if (typeof external === 'function') external();
        };
    }

    /**
     * Re-renders every surface showing any of these title keys (a series key also refreshes its
     * seasons and episodes, and the other way round).
     * @param {string[]} keys Changed title keys.
     * @returns {number} Surfaces refreshed.
     */
    function refresh(keys) {
        const wanted = new Set();
        for (const key of keys || []) {
            if (typeof key !== 'string') continue;
            wanted.add(key);
            wanted.add(key.replace(/:s\d+(:e\d+)?$/, ''));
        }
        const callbacks = new Set();
        for (const [key, set] of subscribers) {
            const title = key.replace(/:s\d+(:e\d+)?$/, '');
            if (wanted.has(key) || wanted.has(title)) set.forEach(cb => callbacks.add(cb));
        }
        callbacks.forEach(cb => {
            try {
                cb([...wanted]);
            } catch (err) {
                console.warn(`${logPrefix} refresh failed`, err);
            }
        });
        return callbacks.size;
    }

    JE.session?.onUserChange?.('arr-status', () => {
        subscribers.clear();
        disabled = false;
        stampsDisabled = false;
    });

    JE.arrStatus = Object.freeze({
        enabled,
        stampsEnabled,
        fetchItem,
        fetchBatch,
        fetchStamps,
        fetchKey,
        feedPosition,
        familyText,
        searchable,
        summaryPieces,
        chipText,
        adminLines,
        adminReasonText,
        formatDate,
        parseDate,
        dayPassed,
        formatEta,
        ageText,
        buildPill,
        buildSummary,
        buildJourney,
        buildBadge,
        staleNote,
        retryDelay,
        subscribe,
        refresh,
        tr,
        el,
        icon
    });
})(window.JellyfinEnhanced);
