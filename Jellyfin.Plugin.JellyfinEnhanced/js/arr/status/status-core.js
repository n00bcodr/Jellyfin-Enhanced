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
     * GET a status route. A 403 feature_disabled switches the module off for this page load.
     * @param {string} path Path under /JellyfinEnhanced.
     * @param {{priority?: 'low', signal?: AbortSignal}} [options] Fetch options.
     * @returns {Promise<{contact: string, lookingHours: number, items: Array<Object>}|null>} The response, or null.
     */
    async function get(path, options) {
        if (!enabled()) return null;
        const api = JE.core?.api;
        try {
            if (api?.plugin) {
                return await api.plugin(path, { priority: options?.priority, signal: options?.signal, skipRetry: true });
            }
            const response = await fetch(ApiClient.getUrl(`/JellyfinEnhanced${path}`), {
                headers: { 'Authorization': `MediaBrowser Token="${ApiClient.accessToken()}"`, 'Accept': 'application/json' },
                signal: options?.signal
            });
            if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
            return await response.json();
        } catch (err) {
            if (err?.name === 'AbortError') return null;
            if (err?.status === 403) disabled = true;
            console.warn(`${logPrefix} status request failed (${err?.status || err?.message || err})`);
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
        const q = [];
        if (ids?.length) q.push(`ids=${ids.map(encodeURIComponent).join(',')}`);
        if (keys?.length) q.push(`keys=${keys.map(encodeURIComponent).join(',')}`);
        return get(`/acquire/status?${q.join('&')}`, { priority: 'low', signal });
    }

    // ------------------------------------------------------------------ formatting

    /**
     * A date as the family reads it: "today", "tomorrow", a weekday within the week, else "14 Nov".
     * @param {string} iso ISO date.
     * @returns {string} The date text ('' when invalid).
     */
    function formatDate(iso) {
        const d = new Date(iso);
        if (!iso || isNaN(d.getTime())) return '';
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
            case 'awaiting_approval': return tr('arr_status_awaiting_approval', { contact });
            case 'approved': return tr('arr_status_approved');
            case 'declined': return tr('arr_status_declined', { contact });
            case 'not_released': return date ? tr('arr_status_not_released_date', { date }) : tr('arr_status_not_released');
            case 'in_cinemas': return date ? tr('arr_status_in_cinemas_date', { date }) : tr('arr_status_in_cinemas');
            case 'not_aired': return date ? tr('arr_status_not_aired_date', { date }) : tr('arr_status_not_aired');
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
            case 'service_down': return tr('arr_status_taking_longer');
            case 'upgrading': return tr('arr_status_upgrading');
            case 'unmonitored': return tr('arr_status_unmonitored');
            case 'not_in_arr':
            case 'not_visible_to_user': return tr('arr_status_not_here');
            case 'ready':
            default: return tr('arr_status_ready');
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
            const date = formatDate(s.nextAir);
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
        if (s.missing > 0) pieces.push({ text: tr('arr_summary_missing', { n: s.missing }), tone: 'looking', icon: 'search' });
        if (s.attention > 0) pieces.push({ text: tr('arr_summary_attention', { n: s.attention }), tone: 'attention', icon: 'schedule' });
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
            if (code === 'stalled') return tr('arr_chip_taking_longer');
            const pct = ep.progress?.percent;
            return typeof pct === 'number' ? tr('arr_chip_downloading_pct', { pct }) : tr('arr_chip_downloading');
        }
        if (ep.stage === 'almostReady') return code === 'import_blocked' ? tr('arr_chip_taking_longer') : tr('arr_chip_almost_ready');
        if (ep.stage === 'notOut') {
            const date = ep.reason?.params?.date || ep.airDate;
            return date ? tr('arr_chip_airs', { date: formatDate(date) }) : tr('arr_chip_not_aired');
        }
        if (ep.stage === 'asked') return tr('arr_chip_waiting_ok');
        if (code === 'failed') return tr('arr_chip_taking_longer');
        if (code === 'unmonitored') return tr('arr_chip_not_fetched');
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
        return lines;
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
        const hasJourney = Array.isArray(status.journey) && status.journey.length > 1;
        const pill = el(hasJourney ? 'button' : 'div', `je-arr-pill je-arr-tone-${tone}`);
        if (hasJourney) {
            pill.type = 'button';
            pill.setAttribute('aria-expanded', 'false');
        }
        pill.appendChild(icon(status.attention ? 'schedule' : (STAGE_ICONS[status.stage] || 'info'), 'je-arr-pill-icon'));
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
     * Downloading ring > attention > almost ready; season cards also show ✓ or "◐ ready/aired".
     * @param {Object} status Card status.
     * @returns {HTMLElement|null} Badge host content.
     */
    function buildBadge(status) {
        if (!status) return null;
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
     * @returns {() => void} Unsubscribe.
     */
    function subscribe(keys, callback) {
        const list = [...new Set((keys || []).filter(Boolean))];
        for (const key of list) {
            if (!subscribers.has(key)) subscribers.set(key, new Set());
            subscribers.get(key).add(callback);
        }
        let external = null;
        if (typeof JE.arr?.onStatusChange === 'function') {
            try {
                external = JE.arr.onStatusChange(list, (changed) => callback(Array.isArray(changed) ? changed : list));
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
            wanted.add(key.replace(/:s\d+(e\d+)?$/, ''));
        }
        const callbacks = new Set();
        for (const [key, set] of subscribers) {
            const title = key.replace(/:s\d+(e\d+)?$/, '');
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
    });

    JE.arrStatus = Object.freeze({
        enabled,
        fetchItem,
        fetchBatch,
        familyText,
        summaryPieces,
        chipText,
        adminLines,
        formatDate,
        formatEta,
        buildPill,
        buildSummary,
        buildJourney,
        buildBadge,
        subscribe,
        refresh,
        tr,
        el,
        icon
    });
})(window.JellyfinEnhanced);
