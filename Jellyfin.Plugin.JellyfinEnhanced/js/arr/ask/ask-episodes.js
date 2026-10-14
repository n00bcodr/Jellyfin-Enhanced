/**
 * @file Requests & downloads, phase 3: missing episodes on season pages (one row per episode, like
 * the native list). On a missing episode's row the "Missing" chip gets a **Get it** button (one tap
 * asks for that episode; the chip then reads "Waiting for OK" or "Asked!" as the server answered);
 * a downloading episode gets the download ring on its thumbnail; a missing episode's thumbnail is
 * dimmed. Where Jellyfin made its own row for a missing episode (the library imports missing
 * episodes) that row is decorated and its own "Missing" label is replaced by the one chip; for every
 * other missing episode JE draws a row that looks like the native ones — when the viewer shows
 * missing episodes within seasons (Jellyfin's per-user display setting). With that setting off the
 * phase-1 "Missing: E4, E7" banner gets **Get them** instead (never both). Plugs into
 * status-episodes.js (JE.internals.arrStatusEpisodes.extend); one GET .../acquire/requests/season/{id}
 * per season page view (and again after an ask or a status change). An episode that is monitored
 * and missing for a long while (JE.arrStatus.searchable) gets **Search** instead of Get it: an
 * administrator's Search runs the arr's search for it at once (Searching…, then what it found);
 * everyone else asks for it like Get it.
 */
(function (JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Ask:';
    const STILL = /^\/[A-Za-z0-9_.-]{1,80}$/;
    /** Stages of an episode that is simply not there (nobody is downloading it). */
    const MISSING_STAGES = new Set(['looking', 'notHere']);

    let season = null; // { itemId, rows, loading, statusRef, generation }
    /** @type {Map<number, {state: string, at: number}>} optimistic states after an ask, until the server agrees */
    const local = new Map();
    /** How long an administrator's Search outcome stays in the place of its button. */
    const SEARCHED_TTL_MS = 2 * 60 * 1000;
    /** @type {Map<number, {chip: string, tone: string, at: number}>} outcomes of an administrator's Search, by episode */
    const searched = new Map();
    /** @type {{chip: string, tone: string, at: number, itemId: string}|null} outcome of an administrator's Search from the banner */
    let bannerSearched = null;
    const busy = new Set();
    let started = false;
    let generation = 0;
    let unsubscribe = null;
    /** @type {{itemId: string|null, close: function(boolean=): void}|null} the episode dialog shown now */
    let shownDialog = null;

    /**
     * Translates (shared helper).
     * @param {string} key Key.
     * @param {Object} [params] Parameters.
     * @returns {string} Text.
     */
    function tr(key, params) {
        return JE.arrStatus ? JE.arrStatus.tr(key, params) : key;
    }

    /**
     * True when the episode is missing and nothing is under way for it (Get it makes sense).
     * @param {Object} ep Episode status.
     * @returns {boolean} Missing.
     */
    function isMissing(ep) {
        if (!ep || !MISSING_STAGES.has(ep.stage) || ep.attention) return false;
        const code = ep.reason?.code;
        return code !== 'service_down' && code !== 'failed';
    }

    /**
     * The request state shown for an episode: an optimistic one right after an ask, else the server's
     * (the episode's own ask first, then an ask for the whole season).
     * @param {number} episode Episode number.
     * @returns {string|null} waiting, asked, declined, household or null.
     */
    function requestState(episode) {
        const optimistic = local.get(episode);
        if (optimistic) return optimistic.state;
        const rows = season?.rows;
        if (!rows) return null;
        const entry = (rows.episodes || []).find(e => e.episode === episode);
        return entry?.request || rows.seasonRequest || null;
    }

    /**
     * The request state that takes the place of Get it / Search on an episode, or null when the
     * episode can be asked for (or searched). A request waiting for an OK, a decline and an ask made
     * from this page a moment ago always do. A request that was already sent (the viewer's or someone
     * else's) gives way to Search once the episode is monitored and missing for a long while: it
     * reads plainly Missing then, like any other episode nothing was found for.
     * @param {Object} ep Episode status.
     * @returns {string|null} waiting, asked, declined, household or null.
     */
    function shownState(ep) {
        const state = requestState(ep.episode);
        if (state !== 'asked' && state !== 'household') return state;
        const mine = local.get(ep.episode);
        if (mine && !(mine.search && Date.now() - mine.at > SEARCHED_TTL_MS)) return state;
        return JE.arrStatus?.searchable?.(ep) ? null : state;
    }

    /**
     * Chip words for a request state.
     * @param {string} stateName Request state.
     * @returns {{text: string, tone: string}|null} Chip.
     */
    function chipForState(stateName) {
        switch (stateName) {
            case 'waiting': return { text: tr('arr_ask_chip_waiting'), tone: 'asked' };
            case 'asked': return { text: tr('arr_ask_chip_asked'), tone: 'approved' };
            case 'household': return { text: tr('arr_ask_chip_household'), tone: 'approved' };
            case 'declined': return { text: tr('arr_ask_chip_declined'), tone: 'attention' };
            default: return null;
        }
    }

    /**
     * True when this page can offer Get it (feature on, rows loaded, the viewer may ask).
     * @returns {boolean} Can ask.
     */
    function canAsk() {
        return !!(JE.arrAsk?.enabled() && season?.rows?.canRequest);
    }

    /**
     * Extension hook: the chip of a missing episode says its request state, or plainly "Missing"
     * (one label, whatever Sonarr's monitoring says) when it can be asked for.
     * @param {Object} ep Episode status.
     * @returns {{text: string, tone: string}|null} Chip override.
     */
    function chip(ep) {
        if (!JE.arrAsk?.enabled() || !isMissing(ep)) return null;
        const byState = chipForState(shownState(ep));
        if (byState) return byState;
        return canAsk() ? { text: tr('arr_chip_missing'), tone: 'notOut' } : null;
    }

    /**
     * The episodes of the season JE shows as rows (Jellyfin has none for them): with the viewer's
     * "display missing episodes" setting on, every episode the banner would list. With no episode
     * list on the page to put rows in (once jellyfin-web has rendered the season), none: the banner
     * says it instead.
     * @param {Object} status Season status.
     * @param {{page?: HTMLElement, list?: HTMLElement|null}} [parts] The season page and its episode list.
     * @returns {Set<number>} Episode numbers.
     */
    function drawn(status, parts) {
        const out = new Set();
        if (!JE.arrAsk?.enabled()) return out;
        ensureRows(status);
        // While the first read is out the banner waits (it may turn out to be rows); a failed read
        // brings it back.
        const loadingFirst = season?.loading && !season?.rows;
        if (!loadingFirst && (!season?.rows?.displayMissing || season.itemId !== normalize(status.itemId))) return out;
        if (parts && !parts.list && !parts.page?.querySelector('#listChildrenCollapsible.hide')) return out;
        let upcoming = false;
        for (const ep of status.episodes || []) {
            if (ep.row || ep.stage === 'ready' || ep.stage === 'none') continue;
            if (ep.stage === 'notOut') {
                if (upcoming) continue;
                upcoming = true;
            }
            out.add(ep.episode);
        }
        return out;
    }

    /**
     * An id without dashes, lower case.
     * @param {string} id Id.
     * @returns {string} Normalized id.
     */
    function normalize(id) {
        return String(id || '').replace(/-/g, '').toLowerCase();
    }

    /**
     * True in jellyfin-web's TV layout: rows are single focus targets there (no buttons inside a row).
     * @returns {boolean} TV layout.
     */
    function isTv() {
        return document.documentElement.classList.contains('layout-tv') || !!document.body?.classList.contains('layout-tv');
    }

    /**
     * Loads the season rows (once per season per status read).
     * @param {Object} status Season status.
     * @returns {void}
     */
    function ensureRows(status) {
        const itemId = normalize(status.itemId);
        if (!itemId) return;
        if (season && season.itemId === itemId && (season.loading || season.statusRef === status)) return;
        const fresh = !season || season.itemId !== itemId;
        if (fresh) {
            local.clear();
            searched.clear();
            bannerSearched = null;
            closeDialog();
        }
        const mine = { itemId, rows: fresh ? null : season.rows, loading: true, statusRef: status, generation: ++generation };
        season = mine;
        load(mine);
    }

    /**
     * Reads the season rows and re-applies the page when they arrive.
     * @param {Object} target The season state the read is for.
     * @returns {Promise<void>}
     */
    async function load(target) {
        const lang = (navigator.language || 'en').split('-')[0];
        let rows = null;
        try {
            const answer = await JE.arrAsk.call(`/acquire/requests/season/${encodeURIComponent(target.itemId)}?language=${encodeURIComponent(lang)}`);
            rows = answer.status === 200 && answer.body?.rows ? answer.body.rows : null;
        } catch (err) {
            if (err?.name !== 'AbortError') console.warn(`${logPrefix} season rows unavailable (${err?.message || err})`);
        }
        if (season !== target || target.generation !== generation) return;
        target.loading = false;
        if (rows) {
            target.rows = rows;
            // The server's answer replaces optimistic states it agrees with (or knows better).
            for (const [episode, entry] of [...local]) {
                const server = (rows.episodes || []).find(e => e.episode === episode)?.request || rows.seasonRequest;
                // A Search's ask stays shown for a while: the server's "asked" gives way to Search again.
                if (Date.now() - entry.at > (entry.search ? SEARCHED_TTL_MS : 60000) || (server && !entry.search)) local.delete(episode);
            }
        }
        JE.internals?.arrStatusEpisodes?.apply?.();
    }

    /**
     * Extension hook: decorates the season page after the phase-1 chips and banner are on.
     * @param {HTMLElement} page Season page.
     * @param {Object} status Season status.
     * @param {Object} ctx Response context.
     * @param {{banner: HTMLElement|null, list: HTMLElement|null, drawn: Set<number>|null}} parts Parts.
     * @returns {void}
     */
    function decorate(page, status, ctx, parts) {
        if (!JE.arrAsk?.enabled()) return;
        JE.internals?.arrAskStyles?.syncTheme?.();
        ensureRows(status);
        const byId = new Map();
        const byNumber = new Map();
        for (const ep of status.episodes || []) {
            byNumber.set(ep.episode, ep);
            if (ep.row && ep.itemId) byId.set(normalize(ep.itemId), ep);
        }
        let list = parts.list;
        page.querySelectorAll('.listItem[data-id]').forEach((row) => {
            const ep = byId.get(normalize(row.getAttribute('data-id')));
            decorateNative(row, ep);
            if (!list && row.getAttribute('data-type') === 'Episode') list = row.closest('.itemsContainer');
        });
        syncDrawnRows(page, status, ctx, list, season?.rows?.displayMissing ? (parts.drawn || new Set()) : new Set(), byNumber);
        decorateBanner(parts.banner, status);
    }

    /**
     * One native row: Get it next to its chip, dimmed thumbnail for a missing episode, download ring
     * for a downloading one, and Jellyfin's own missing label hidden when JE's chip says it.
     * @param {HTMLElement} row Native row.
     * @param {Object|undefined} ep Episode status.
     * @returns {void}
     */
    function decorateNative(row, ep) {
        const chipEl = row.querySelector('.je-arr-chip');
        const missing = !!ep && isMissing(ep);
        row.classList.toggle('je-ask-dim', missing);
        // Jellyfin's red "Missing" (or "Unaired") label on its own virtual rows: JE's chip says it now.
        const virtual = !!row.querySelector('.missingIndicator, .unairedIndicator');
        row.classList.toggle('je-ask-native-label-off', !!chipEl && virtual);
        if (virtual && ep) syncMeta(row, ep);
        syncRing(row.querySelector('.listItemImage'), ep);
        syncGetIt(chipEl, ep, row);
    }

    /**
     * Jellyfin's rows for missing episodes print no runtime or air date: add them (from the season
     * read) at the start of the row's info line, like the rows of episodes that are here.
     * @param {HTMLElement} row Native virtual row.
     * @param {Object} ep Episode status.
     * @returns {void}
     */
    function syncMeta(row, ep) {
        const line = row.querySelector('.listItemMediaInfo');
        if (!line || line.querySelector('.mediaInfoItem:not(.je-ask-meta)')) return;
        const meta = metaOf(ep.episode) || {};
        const parts = [meta.runtime ? `${meta.runtime}m` : '', longDate(meta.airDate || ep.airDate || '')].filter(Boolean);
        const signature = parts.join('|');
        const existing = [...line.querySelectorAll('.je-ask-meta')];
        if (existing.map(n => n.textContent).join('|') === signature) return;
        existing.forEach(n => n.remove());
        for (const text of parts.reverse()) line.insertBefore(JE.arrStatus.el('div', 'mediaInfoItem je-ask-meta', text), line.firstChild);
    }

    /**
     * Puts (or removes) the Get it button right after a chip.
     * @param {HTMLElement|null} chipEl The chip.
     * @param {Object|undefined} ep Episode status.
     * @param {HTMLElement} scope Row the button belongs to.
     * @returns {void}
     */
    function syncGetIt(chipEl, ep, scope) {
        // On TV a row is one focus target (Jellyfin's own rows are buttons there): Get it lives in the
        // episode's dialog (JE rows) or on the episode's page (Jellyfin's rows), never inside a row.
        const placeable = !!chipEl && !!ep && isMissing(ep) && canAsk() && !shownState(ep) && !chipEl.classList.contains('je-arr-chip-overlay') && !isTv();
        const outcome = placeable ? searchedOutcome(ep.episode) : null;
        const want = placeable && !outcome;
        const existing = scope.querySelector(`.je-ask-get[data-je-ask-episode="${ep?.episode}"]`) || scope.querySelector('.je-ask-get');
        syncSearched(chipEl, scope, outcome);
        if (!want) {
            if (existing && !busy.has(Number(existing.dataset.jeAskEpisode))) existing.remove();
            return;
        }
        if (existing && existing.previousElementSibling === chipEl && existing.dataset.mode === modeOf(ep)) {
            setBusyLook(existing, busy.has(ep.episode));
            return;
        }
        if (existing) existing.remove();
        chipEl.insertAdjacentElement('afterend', getItButton(ep));
    }

    /**
     * Whether an episode's button asks for it (Get it) or searches for it (Search: monitored and
     * missing for a long while, see JE.arrStatus.searchable).
     * @param {Object} ep Episode status.
     * @returns {'get'|'search'} Mode.
     */
    function modeOf(ep) {
        return JE.arrStatus?.searchable?.(ep) ? 'search' : 'get';
    }

    /**
     * The outcome of an administrator's recent Search for an episode, while it is fresh.
     * @param {number} episode Episode number.
     * @returns {{chip: string, tone: string, at: number}|null} Outcome.
     */
    function searchedOutcome(episode) {
        const entry = searched.get(episode);
        if (!entry) return null;
        if (Date.now() - entry.at > SEARCHED_TTL_MS) {
            searched.delete(episode);
            return null;
        }
        return entry;
    }

    /**
     * Shows (or removes) a Search outcome right after a chip ("Nothing found yet · searched just now").
     * @param {HTMLElement|null} chipEl The chip.
     * @param {HTMLElement} scope Row.
     * @param {{chip: string, tone: string}|null} outcome Outcome, or null for none.
     * @returns {void}
     */
    function syncSearched(chipEl, scope, outcome) {
        const existing = scope.querySelector('.je-ask-searched');
        if (!outcome || !chipEl) {
            if (existing) existing.remove();
            return;
        }
        if (existing && existing.previousElementSibling === chipEl && existing.textContent === outcome.chip) return;
        if (existing) existing.remove();
        const note = JE.arrStatus.el('span', `je-arr-chip je-ask-searched je-arr-tone-${outcome.tone}`, outcome.chip);
        note.tabIndex = -1;
        chipEl.insertAdjacentElement('afterend', note);
    }

    /**
     * A Get it button for one episode.
     * @param {Object} ep Episode status.
     * @returns {HTMLButtonElement} Button.
     */
    function getItButton(ep) {
        const S = JE.arrStatus;
        const mode = modeOf(ep);
        const btn = S.el('button', `je-ask-get${mode === 'search' ? ' je-ask-search' : ''}`);
        btn.type = 'button';
        btn.dataset.jeAskEpisode = String(ep.episode);
        btn.dataset.jeFocus = `ask-get-${ep.episode}`;
        btn.dataset.mode = mode;
        btn.dataset.label = mode === 'search' ? tr('arr_ask_search') : tr('arr_ask_get_it');
        if (mode === 'search') btn.dataset.busyLabel = tr('arr_ask_searching');
        btn.appendChild(S.icon(mode === 'search' ? 'search' : 'add', 'je-ask-get-icon'));
        btn.appendChild(S.el('span', 'je-ask-get-text', btn.dataset.label));
        const meta = metaOf(ep.episode);
        const title = meta?.title || tr('arr_ask_episode_title', { episode: ep.episode });
        btn.setAttribute('aria-label', tr(mode === 'search' ? 'arr_ask_search_label' : 'arr_ask_get_it_label', { episode: ep.episode, title }));
        // The button asks for this season's episode only, even if another season is shown by the
        // time it is pressed (a dialog left open across a navigation).
        const scope = season?.itemId || null;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (mode === 'search') searchEpisode(ep, btn, scope);
            else getEpisodes([ep.episode], btn, false, scope);
        });
        setBusyLook(btn, busy.has(ep.episode));
        return btn;
    }

    /**
     * Shows a button as busy (Asking…) or ready.
     * @param {HTMLButtonElement} btn Button.
     * @param {boolean} on Busy.
     * @returns {void}
     */
    function setBusyLook(btn, on) {
        btn.disabled = on;
        btn.setAttribute('aria-busy', String(on));
        const text = btn.querySelector('.je-ask-get-text');
        const label = btn.dataset.label || tr('arr_ask_get_it');
        if (text) text.textContent = on ? (btn.dataset.busyLabel || tr('arr_ask_asking')) : label;
    }

    /**
     * Search for an episode missing for a long while. An administrator's Search runs the arr's own
     * search for that episode right away (Searching…, then what it found, in place of the button);
     * everyone else asks for the episode like Get it (the request backend turns it into a search).
     * @param {Object} ep Episode status.
     * @param {HTMLButtonElement} button The button pressed.
     * @param {string|null} [scope] The season the button was made for (nothing happens on another).
     * @returns {Promise<void>}
     */
    async function searchEpisode(ep, button, scope) {
        const target = season;
        if (!target?.rows || busy.has(ep.episode) || (scope && target.itemId !== scope)) return;
        // Capabilities are read for this session: a sign-out (and someone else's sign-in) before
        // they arrive drops the Search instead of running it with the next person's token.
        const started = JE.arrAsk.epoch();
        const caps = await JE.arrAsk.me();
        if (JE.arrAsk.epoch() !== started || season !== target) return;
        const instanceId = JE.arrAsk.searchInstance(caps, target.statusRef, ep.key);
        if (!instanceId) {
            await getEpisodes([ep.episode], button, true, target.itemId);
            return;
        }
        const place = button?.closest('.listItem') || null;
        busy.add(ep.episode);
        JE.internals?.arrStatusEpisodes?.apply?.();
        let result;
        try {
            result = await JE.arrAsk.adminSearch(ep.key, instanceId);
        } finally {
            busy.delete(ep.episode);
        }
        if (JE.arrAsk.epoch() !== started) return;
        const stillHere = !!season && season.itemId === target.itemId;
        if (stillHere && result.chip) searched.set(ep.episode, { chip: result.chip, tone: result.tone, at: Date.now() });
        announce(result.text);
        JE.arrAsk.toast(result.text);
        if (!stillHere) return;
        JE.internals?.arrStatusEpisodes?.apply?.();
        // The outcome takes the focus the button had (keyboard and TV users stay in place).
        if (button && !document.contains(button)) {
            const holder = place && document.contains(place) ? place : document.querySelector(`.je-ask-row[data-je-ask-episode="${ep.episode}"]`);
            const focusTarget = holder?.querySelector('.je-ask-searched, .je-ask-get, .je-arr-chip') || null;
            if (focusTarget) {
                if (focusTarget.tagName !== 'BUTTON') focusTarget.tabIndex = -1;
                focusTarget.focus();
            }
        }
    }

    /**
     * Asks for episodes of this season (Get it / Get them, or Search for people who ask) and shows
     * the answer honestly.
     * @param {number[]} episodes Episode numbers.
     * @param {HTMLButtonElement} button The button pressed (focus goes to the new chip after).
     * @param {boolean} [search] The ask is a Search (its state then shows for a while only).
     * @param {string|null} [scope] The season the button was made for (nothing is asked on another).
     * @returns {Promise<void>}
     */
    async function getEpisodes(episodes, button, search, scope) {
        const target = season;
        const rows = target?.rows;
        if (!rows || !episodes.length || episodes.some(n => busy.has(n)) || (scope && target.itemId !== scope)) return;
        const place = button?.closest('.listItem, .je-arr-banner') || null;
        const placeEpisode = place?.classList.contains('je-ask-row') ? place.dataset.jeAskEpisode : null;
        episodes.forEach(n => busy.add(n));
        JE.internals?.arrStatusEpisodes?.apply?.();
        const input = JE.arrAsk.episodesInput(rows.series, episodes.map(episode => ({ season: rows.season, episode })));
        let result;
        try {
            result = await JE.arrAsk.ask(input);
        } finally {
            episodes.forEach(n => busy.delete(n));
        }
        // Answered after a sign-out: the next person is not told about it.
        if (result.stale) return;
        const caps = await JE.arrAsk.me();
        const allowance = result.state === 'quota' ? await JE.arrAsk.quota('tv') : null;
        const words = JE.arrAsk.describe(result, caps, allowance);
        // The same season page is still shown (the ask itself makes the page read the season again).
        const stillHere = !!season && season.itemId === target.itemId;
        if (result.ok || result.state === 'unknown') {
            const shown = result.state === 'waiting' ? 'waiting' : result.state === 'nothing' ? null : result.state === 'declined' ? 'declined' : 'asked';
            if (shown && stillHere) episodes.forEach(n => local.set(n, { state: shown, at: Date.now(), search: !!search }));
        }
        announce(words.text);
        JE.arrAsk.toast(words.text);
        if (stillHere) {
            JE.internals?.arrStatusEpisodes?.apply?.();
            // The new chip takes the focus the button had (keyboard and TV users stay in place).
            if (button && !document.contains(button)) {
                let holder = place && document.contains(place) ? place : null;
                if (!holder && placeEpisode) holder = document.querySelector(`.je-ask-row[data-je-ask-episode="${placeEpisode}"]`);
                if (!holder && place?.classList.contains('je-arr-banner')) holder = document.querySelector('#itemDetailPage:not(.hide) .je-arr-banner');
                const focusTarget = holder?.querySelector('.je-ask-banner-action .je-arr-chip, .je-arr-chip') || null;
                if (focusTarget) {
                    focusTarget.tabIndex = -1;
                    focusTarget.focus();
                }
            }
            // The server's truth is read again through JE.arrAsk.onChange (see initialize).
        }
    }

    /**
     * Announces a result to screen readers (polite live region).
     * @param {string} text Text.
     * @returns {void}
     */
    function announce(text) {
        let region = document.getElementById('je-ask-live');
        if (!region) {
            region = document.createElement('div');
            region.id = 'je-ask-live';
            region.className = 'je-ask-sr';
            region.setAttribute('role', 'status');
            region.setAttribute('aria-live', 'polite');
            document.body.appendChild(region);
        }
        region.textContent = '';
        setTimeout(() => { region.textContent = text || ''; }, 50);
    }

    /**
     * Server metadata of one episode (title, overview, runtime, air date, still), or null.
     * @param {number} episode Episode number.
     * @returns {Object|null} Metadata.
     */
    function metaOf(episode) {
        return (season?.rows?.episodes || []).find(e => e.episode === episode) || null;
    }

    /**
     * Puts the download ring on a thumbnail while the episode downloads (removes it otherwise).
     * @param {HTMLElement|null} image Thumbnail element.
     * @param {Object|undefined} ep Episode status.
     * @returns {void}
     */
    function syncRing(image, ep) {
        if (!image) return;
        const downloading = !!ep && ep.stage === 'downloading' && !ep.attention;
        const pct = typeof ep?.progress?.percent === 'number' ? Math.round(ep.progress.percent) : null;
        let holder = image.querySelector('.je-ask-ring');
        if (!downloading) {
            if (holder) holder.remove();
            return;
        }
        if (holder && holder.dataset.pct === String(pct)) return;
        if (holder) holder.remove();
        holder = document.createElement('div');
        holder.className = 'je-ask-ring';
        holder.dataset.pct = String(pct);
        holder.appendChild(JE.arrStatus.buildBadge({ stage: 'downloading', progress: pct == null ? undefined : { percent: pct } })?.querySelector('.je-arr-ring') || document.createElement('span'));
        holder.setAttribute('role', 'img');
        holder.setAttribute('aria-label', pct == null ? tr('arr_chip_downloading') : tr('arr_chip_downloading_pct', { pct }));
        image.appendChild(holder);
    }

    /**
     * Keeps JE's drawn rows in the list: one per drawn episode, in episode order among the native
     * rows; removes rows that are no longer needed (Jellyfin made its own, or the episode arrived).
     * @param {HTMLElement} page Season page.
     * @param {Object} status Season status.
     * @param {Object} ctx Response context.
     * @param {HTMLElement|null} list The episode list.
     * @param {Set<number>} wanted Episodes to draw.
     * @param {Map<number, Object>} byNumber Episode statuses by number.
     * @returns {void}
     */
    function syncDrawnRows(page, status, ctx, list, wanted, byNumber) {
        page.querySelectorAll('.je-ask-row').forEach((row) => {
            const n = Number(row.dataset.jeAskEpisode);
            if (!list || !wanted.has(n) || row.parentNode !== list) row.remove();
        });
        if (!list || !wanted.size) return;
        // Episode numbers of the native rows, to place JE's rows between them.
        const natives = [];
        list.querySelectorAll(':scope > .listItem[data-id]').forEach((row) => {
            const id = normalize(row.getAttribute('data-id'));
            const ep = (status.episodes || []).find(e => e.itemId && normalize(e.itemId) === id);
            if (ep) natives.push({ n: ep.episode, row });
        });
        for (const n of [...wanted].sort((a, b) => a - b)) {
            const ep = byNumber.get(n);
            if (!ep) continue;
            let row = list.querySelector(`:scope > .je-ask-row[data-je-ask-episode="${n}"]`);
            const signature = rowSignature(ep);
            if (row && row.dataset.sig !== signature) {
                const hadFocus = row.contains(document.activeElement);
                const replacement = buildRow(ep, ctx);
                row.replaceWith(replacement);
                row = replacement;
                // Keyboard and TV users stay on the row they were on.
                if (hadFocus) (row.matches('button') ? row : row.querySelector('.je-ask-row-title'))?.focus();
            } else if (!row) {
                row = buildRow(ep, ctx);
            }
            const after = natives.filter(x => x.n < n).pop();
            const drawnBefore = [...list.querySelectorAll(':scope > .je-ask-row')].filter(r => Number(r.dataset.jeAskEpisode) < n && r !== row).pop();
            const anchor = [after?.row, drawnBefore].filter(Boolean).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)).pop();
            if (anchor) {
                if (anchor.nextElementSibling !== row) anchor.insertAdjacentElement('afterend', row);
            } else if (list.firstElementChild !== row) {
                list.insertBefore(row, list.firstElementChild);
            }
            placeChip(row);
            syncRing(row.querySelector('.listItemImage'), ep);
            syncGetIt(row.querySelector('.je-arr-chip'), ep, row);
        }
    }

    /**
     * Phone layouts hide a row's info line (as Jellyfin does for its own rows): the chip then moves to
     * a line of its own above the overview, like the phase-1 chips on native rows.
     * @param {HTMLElement} row JE row.
     * @returns {void}
     */
    function placeChip(row) {
        const line = row.querySelector('.listItemMediaInfo');
        const chipEl = row.querySelector('.je-arr-chip');
        if (!line || !chipEl) return;
        const lineShown = getComputedStyle(line).display !== 'none';
        let holder = row.querySelector('.je-arr-chip-row');
        if (lineShown) {
            if (chipEl.parentNode !== line) line.appendChild(chipEl);
            if (holder) holder.remove();
            return;
        }
        if (!holder) {
            holder = document.createElement('div');
            holder.className = 'je-arr-chip-row';
            const below = row.querySelector('.listItem-bottomoverview');
            if (below) row.insertBefore(holder, below);
            else row.appendChild(holder);
        }
        if (chipEl.parentNode !== holder) holder.appendChild(chipEl);
    }

    /**
     * What a drawn row shows (it is rebuilt when this changes).
     * @param {Object} ep Episode status.
     * @returns {string} Signature.
     */
    function rowSignature(ep) {
        const meta = metaOf(ep.episode);
        const c = chip(ep);
        return [ep.stage, ep.reason?.code, ep.progress?.percent, c?.text || JE.arrStatus.chipText(ep), meta?.title, meta?.still, JE.spoilerBlur?.isEnabledFor?.(season?.rows?.seriesId) ? 's' : '', isTv() ? 'tv' : ''].join('|');
    }

    /**
     * Builds a JE row for an episode Jellyfin has no row for, with the native row's classes so it
     * looks the same (number and title, runtime, air date, chip, overview, thumbnail). The row is
     * not a Jellyfin item: clicks stay inside it; its title opens the episode's status details.
     * @param {Object} ep Episode status.
     * @param {Object} ctx Response context.
     * @returns {HTMLElement} Row.
     */
    function buildRow(ep, ctx) {
        const S = JE.arrStatus;
        const meta = metaOf(ep.episode) || {};
        const spoiler = !!JE.spoilerBlur?.isEnabledFor?.(season?.rows?.seriesId);
        const title = meta.title || tr('arr_ask_episode_title', { episode: ep.episode });
        if (isTv()) return buildTvRow(ep, ctx, meta, title, spoiler);
        const row = S.el('div', 'listItem listItem-largeImage listItem-withContentWrapper je-ask-row');
        row.dataset.jeAskEpisode = String(ep.episode);
        row.dataset.sig = rowSignature(ep);
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', isMissing(ep) ? tr('arr_ask_row_missing_label', { episode: ep.episode }) : `${ep.episode}. ${title}`);
        if (isMissing(ep)) row.classList.add('je-ask-dim');
        // Jellyfin's list handles clicks, long presses and context menus of its items by delegation:
        // this row is not an item, so none of that may reach it.
        for (const type of ['click', 'contextmenu', 'mousedown', 'pointerdown', 'touchstart', 'keydown']) {
            row.addEventListener(type, (e) => e.stopPropagation());
        }
        const content = S.el('div', 'listItem-content');
        const image = S.el('div', 'listItemImage listItemImage-large je-ask-row-image');
        const still = typeof meta.still === 'string' && STILL.test(meta.still) ? meta.still : null;
        if (still) image.style.backgroundImage = `url("https://image.tmdb.org/t/p/w300${still}")`;
        else image.appendChild(S.icon('tv', 'je-ask-row-placeholder'));
        if (spoiler) image.classList.add('je-ask-row-spoiler');
        image.addEventListener('click', () => openDetails(ep, ctx));
        content.appendChild(image);

        const body = S.el('div', 'listItemBody je-ask-row-body');
        const heading = S.el('div', 'listItemBodyText');
        const open = S.el('button', 'je-ask-row-title');
        open.type = 'button';
        open.dataset.jeFocus = `ask-row-${ep.episode}`;
        const bdi = document.createElement('bdi');
        bdi.textContent = `${ep.episode}. ${title}`;
        open.appendChild(bdi);
        open.title = tr('arr_ask_row_open', { episode: ep.episode });
        open.addEventListener('click', () => openDetails(ep, ctx));
        heading.appendChild(open);
        body.appendChild(heading);

        const info = S.el('div', 'secondary listItemMediaInfo listItemBodyText');
        if (meta.runtime) info.appendChild(S.el('div', 'mediaInfoItem', `${meta.runtime}m`));
        const air = meta.airDate || ep.airDate;
        const airText = air ? longDate(air) : '';
        if (airText) info.appendChild(S.el('div', 'mediaInfoItem', airText));
        const c = chip(ep);
        const chipEl = S.el('span', `je-arr-chip je-arr-tone-${c?.tone || (ep.attention ? 'attention' : ep.stage)}`, c?.text || S.chipText(ep));
        chipEl.dataset.jeArrKey = ep.key || '';
        info.appendChild(chipEl);
        body.appendChild(info);

        if (meta.overview && !spoiler) {
            const overview = S.el('div', 'secondary listItem-overview listItemBodyText');
            const text = document.createElement('bdi');
            text.textContent = meta.overview;
            overview.appendChild(text);
            body.appendChild(overview);
        }
        content.appendChild(body);

        const buttons = S.el('div', 'listViewUserDataButtons');
        const infoButton = S.el('button', 'listItemButton paper-icon-button-light je-ask-row-info');
        infoButton.type = 'button';
        infoButton.title = tr('arr_ask_row_open', { episode: ep.episode });
        infoButton.setAttribute('aria-label', tr('arr_ask_row_open', { episode: ep.episode }));
        infoButton.appendChild(S.icon('info_outline'));
        infoButton.addEventListener('click', () => openDetails(ep, ctx));
        buttons.appendChild(infoButton);
        content.appendChild(buttons);
        row.appendChild(content);

        if (meta.overview && !spoiler) {
            const bottom = S.el('div', 'listItem-bottomoverview secondary');
            const text = document.createElement('bdi');
            text.textContent = meta.overview;
            bottom.appendChild(text);
            row.appendChild(bottom);
        }
        return row;
    }

    /**
     * The TV layout's row: one button like Jellyfin's own TV rows (thumbnail, number and title, info
     * line with the chip, overview); selecting it opens the episode's dialog, which holds Get it.
     * @param {Object} ep Episode status.
     * @param {Object} ctx Response context.
     * @param {Object} meta Season-read metadata.
     * @param {string} title Title.
     * @param {boolean} spoiler Spoiler Guard protects the series.
     * @returns {HTMLButtonElement} Row.
     */
    function buildTvRow(ep, ctx, meta, title, spoiler) {
        const S = JE.arrStatus;
        const row = S.el('button', 'listItem listItem-button listItem-focusscale listItem-largeImage je-ask-row');
        row.type = 'button';
        row.dataset.jeAskEpisode = String(ep.episode);
        row.dataset.sig = rowSignature(ep);
        row.dataset.jeFocus = `ask-row-${ep.episode}`;
        if (isMissing(ep)) row.classList.add('je-ask-dim');
        for (const type of ['contextmenu', 'mousedown', 'pointerdown', 'touchstart']) row.addEventListener(type, (e) => e.stopPropagation());
        row.addEventListener('click', (e) => {
            e.stopPropagation();
            openDetails(ep, ctx);
        });
        const image = S.el('div', 'listItemImage listItemImage-large listItemImage-large-tv je-ask-row-image');
        const still = typeof meta.still === 'string' && STILL.test(meta.still) ? meta.still : null;
        if (still) image.style.backgroundImage = `url("https://image.tmdb.org/t/p/w300${still}")`;
        else image.appendChild(S.icon('tv', 'je-ask-row-placeholder'));
        if (spoiler) image.classList.add('je-ask-row-spoiler');
        row.appendChild(image);
        const body = S.el('div', 'listItemBody');
        const heading = S.el('h2', 'listItemBodyText');
        const bdi = document.createElement('bdi');
        bdi.textContent = `${ep.episode}. ${title}`;
        heading.appendChild(bdi);
        body.appendChild(heading);
        const info = S.el('div', 'secondary listItemMediaInfo listItemBodyText');
        if (meta.runtime) info.appendChild(S.el('div', 'mediaInfoItem', `${meta.runtime}m`));
        const airText = longDate(meta.airDate || ep.airDate || '');
        if (airText) info.appendChild(S.el('div', 'mediaInfoItem', airText));
        const c = chip(ep);
        const chipEl = S.el('span', `je-arr-chip je-arr-tone-${c?.tone || (ep.attention ? 'attention' : ep.stage)}`, c?.text || S.chipText(ep));
        chipEl.dataset.jeArrKey = ep.key || '';
        info.appendChild(chipEl);
        body.appendChild(info);
        if (meta.overview && !spoiler) {
            const overview = S.el('div', 'secondary listItem-overview listItemBodyText');
            const text = document.createElement('bdi');
            text.textContent = meta.overview;
            overview.appendChild(text);
            body.appendChild(overview);
        }
        row.appendChild(body);
        row.appendChild(S.el('div', 'listViewUserDataButtons'));
        return row;
    }

    /**
     * A date as the native rows print it ("29 Jun 2014").
     * @param {string} iso ISO date or yyyy-MM-dd.
     * @returns {string} Text.
     */
    function longDate(iso) {
        const d = JE.arrStatus.parseDate(String(iso).slice(0, 10));
        return d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    }

    /**
     * The banner (viewer doesn't show missing episodes as rows): the request state of each missing
     * episode already asked for ("E4 · Waiting for OK"), and Get them (or "Get E8" for one) for the rest.
     * @param {HTMLElement|null} banner Banner.
     * @param {Object} status Season status.
     * @returns {void}
     */
    function decorateBanner(banner, status) {
        if (!banner) return;
        const S = JE.arrStatus;
        const missingEps = JE.internals.arrStatusEpisodes.bannerEntries(status).missing.filter(isMissing);
        const missing = missingEps.map(ep => ep.episode);
        const states = new Map(missingEps.map(ep => [ep.episode, shownState(ep)]));
        const openEps = missingEps.filter(ep => !states.get(ep.episode));
        const open = openEps.map(ep => ep.episode);
        const asked = missing.filter(n => states.get(n));
        // Every episode left is monitored and missing for a long while: the button searches.
        const search = open.length > 0 && openEps.every(ep => !!S.searchable?.(ep));
        if (bannerSearched && (bannerSearched.itemId !== normalize(status.itemId) || Date.now() - bannerSearched.at > SEARCHED_TTL_MS)) bannerSearched = null;
        const outcome = search ? bannerSearched : null;
        let action = banner.querySelector('.je-ask-banner-action');
        const signature = `${open.join(',')}|${asked.map(n => `${n}:${states.get(n)}`).join(',')}|${canAsk()}|${missing.some(n => busy.has(n))}|${search}|${outcome?.chip || ''}`;
        if (action && action.dataset.sig === signature) return;
        if (action) action.remove();
        if (!missing.length) return;
        action = S.el('div', 'je-ask-banner-action');
        action.dataset.sig = signature;
        for (const n of asked) {
            const shown = chipForState(states.get(n));
            if (shown) action.appendChild(S.el('span', `je-arr-chip je-arr-tone-${shown.tone}`, `E${n} · ${shown.text}`));
        }
        if (outcome && canAsk()) {
            const note = S.el('span', `je-arr-chip je-ask-searched je-arr-tone-${outcome.tone}`, outcome.chip);
            note.tabIndex = -1;
            action.appendChild(note);
        } else if (open.length && canAsk()) {
            const btn = S.el('button', `je-ask-get je-ask-get-many${search ? ' je-ask-search' : ''}`);
            btn.type = 'button';
            btn.dataset.jeFocus = 'ask-get-them';
            if (search) {
                btn.dataset.label = open.length === 1 ? tr('arr_ask_search_one', { episode: open[0] }) : tr('arr_ask_search');
                btn.dataset.busyLabel = tr('arr_ask_searching');
            } else {
                btn.dataset.label = open.length === 1 ? tr('arr_ask_get_one', { episode: open[0] }) : tr('arr_ask_get_them');
            }
            btn.appendChild(S.icon(search ? 'search' : 'download', 'je-ask-get-icon'));
            btn.appendChild(S.el('span', 'je-ask-get-text', btn.dataset.label));
            const list = open.map(n => `E${n}`).join(', ');
            btn.setAttribute('aria-label', search ? tr('arr_ask_search_them_label', { list }) : tr('arr_ask_get_them_label', { list }));
            const scope = normalize(status.itemId);
            btn.addEventListener('click', () => (search ? searchBanner(openEps, status, btn) : getEpisodes(open, btn, false, scope)));
            setBusyLook(btn, open.some(n => busy.has(n)));
            action.appendChild(btn);
        }
        if (action.childNodes.length) banner.appendChild(action);
    }

    /**
     * Search from the banner for the season's episodes missing for a long while. An administrator's
     * Search runs the arr's search for that episode (one) or the season (several: the season search
     * looks for exactly its monitored missing episodes) and shows what it found in the banner;
     * everyone else asks for those episodes like Get them.
     * @param {Array<Object>} eps Episode statuses.
     * @param {Object} status Season status.
     * @param {HTMLButtonElement} button The button pressed.
     * @returns {Promise<void>}
     */
    async function searchBanner(eps, status, button) {
        const target = season;
        const numbers = eps.map(ep => ep.episode);
        if (!target?.rows || !numbers.length || numbers.some(n => busy.has(n)) || target.itemId !== normalize(status.itemId)) return;
        const key = eps.length === 1 ? eps[0].key : status.key;
        const started = JE.arrAsk.epoch();
        const caps = await JE.arrAsk.me();
        if (JE.arrAsk.epoch() !== started || season !== target) return;
        const instanceId = key ? JE.arrAsk.searchInstance(caps, status, key) : null;
        if (!instanceId) {
            await getEpisodes(numbers, button, true, target.itemId);
            return;
        }
        numbers.forEach(n => busy.add(n));
        JE.internals?.arrStatusEpisodes?.apply?.();
        let result;
        try {
            result = await JE.arrAsk.adminSearch(key, instanceId);
        } finally {
            numbers.forEach(n => busy.delete(n));
        }
        if (JE.arrAsk.epoch() !== started) return;
        const stillHere = !!season && season.itemId === target.itemId;
        if (stillHere && result.chip) bannerSearched = { chip: result.chip, tone: result.tone, at: Date.now(), itemId: target.itemId };
        announce(result.text);
        JE.arrAsk.toast(result.text);
        if (!stillHere) return;
        JE.internals?.arrStatusEpisodes?.apply?.();
        if (button && !document.contains(button)) {
            const focusTarget = document.querySelector('#itemDetailPage:not(.hide) .je-arr-banner .je-ask-banner-action .je-ask-searched, #itemDetailPage:not(.hide) .je-arr-banner .je-ask-get');
            if (focusTarget) {
                if (focusTarget.tagName !== 'BUTTON') focusTarget.tabIndex = -1;
                focusTarget.focus();
            }
        }
    }

    /**
     * The episode's status details (from a JE row): title, air date, runtime, overview, the status
     * pill and journey, and Get it. A focus-trapped dialog; Escape or Close returns focus. It closes
     * by itself when the page changes (navigation, another season, a sign-out).
     * @param {Object} ep Episode status.
     * @param {Object} ctx Response context.
     * @returns {void}
     */
    function openDetails(ep, ctx) {
        const S = JE.arrStatus;
        closeDialog();
        const opener = document.activeElement;
        const meta = metaOf(ep.episode) || {};
        const spoiler = !!JE.spoilerBlur?.isEnabledFor?.(season?.rows?.seriesId);
        const backdrop = S.el('div', 'je-ask-dialog-backdrop');
        const dialog = S.el('div', 'je-ask-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        const titleId = `je-ask-dialog-title-${ep.episode}`;
        dialog.setAttribute('aria-labelledby', titleId);
        const heading = S.el('h2', 'je-ask-dialog-title', `${ep.episode}. ${meta.title || tr('arr_ask_episode_title', { episode: ep.episode })}`);
        heading.id = titleId;
        dialog.appendChild(heading);
        const facts = [meta.runtime ? `${meta.runtime}m` : '', longDate(meta.airDate || ep.airDate || '')].filter(Boolean).join(' · ');
        if (facts) dialog.appendChild(S.el('div', 'je-ask-dialog-facts', facts));
        const c = chip(ep);
        const pillStatus = { ...ep, journey: null };
        const pill = S.buildPill(pillStatus, ctx);
        if (c && shownState(ep)) {
            const text = pill.querySelector('.je-arr-pill-text');
            if (text) text.textContent = c.text;
        }
        dialog.appendChild(pill);
        if (meta.overview && !spoiler) dialog.appendChild(S.el('p', 'je-ask-dialog-overview', meta.overview));
        const actions = S.el('div', 'je-ask-dialog-actions');
        if (isMissing(ep) && canAsk() && !shownState(ep) && !searchedOutcome(ep.episode)) {
            const get = getItButton(ep);
            get.classList.add('je-ask-get-large');
            get.addEventListener('click', () => close());
            actions.appendChild(get);
        }
        const closeBtn = S.el('button', 'je-ask-dialog-close', tr('arr_ask_close'));
        closeBtn.type = 'button';
        closeBtn.addEventListener('click', () => close());
        actions.appendChild(closeBtn);
        dialog.appendChild(actions);
        backdrop.appendChild(dialog);
        const onKey = (e) => {
            if (e.key === 'Escape' || e.key === 'BrowserBack' || e.key === 'GoBack' || (e.key === 'Backspace' && !/input|textarea/i.test(e.target?.tagName || ''))) {
                e.preventDefault();
                e.stopPropagation();
                close();
            } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                // TV remotes: move between the dialog's buttons only (the page behind stays put).
                const focusables = [...dialog.querySelectorAll('button:not([disabled])')];
                if (!focusables.length) return;
                e.preventDefault();
                e.stopPropagation();
                const at = focusables.indexOf(document.activeElement);
                const step = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1;
                focusables[(at + step + focusables.length) % focusables.length].focus();
            } else if (e.key === 'Tab') {
                const focusables = [...dialog.querySelectorAll('button:not([disabled])')];
                if (!focusables.length) return;
                const first = focusables[0];
                const last = focusables[focusables.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        };
        const shownAt = location.href;
        const offNavigate = JE.core?.navigation?.onNavigate?.(() => { if (location.href !== shownAt) close(false); });
        /**
         * Closes the dialog and (unless the page changed under it) returns focus to what opened it.
         * @param {boolean} [restore] Return focus to the opener (default true).
         * @returns {void}
         */
        function close(restore) {
            if (shownDialog?.close === close) shownDialog = null;
            document.removeEventListener('keydown', onKey, true);
            if (typeof offNavigate === 'function') offNavigate();
            if (!backdrop.isConnected) return;
            backdrop.remove();
            if (restore !== false && opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
        }
        shownDialog = { itemId: season?.itemId || null, close };
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(backdrop);
        (actions.querySelector('button') || closeBtn).focus();
    }

    /**
     * Closes the episode dialog if one is shown, without moving focus to its opener (the page it
     * was opened from is gone or belongs to someone else).
     * @returns {void}
     */
    function closeDialog() {
        if (shownDialog) shownDialog.close(false);
    }

    /**
     * Extension hook: removes everything this module added to a page.
     * @param {HTMLElement} page Page.
     * @returns {void}
     */
    function clear(page) {
        closeDialog();
        (page || document).querySelectorAll('.je-ask-row, .je-ask-get, .je-ask-searched, .je-ask-ring, .je-ask-banner-action, .je-ask-meta').forEach(n => n.remove());
        (page || document).querySelectorAll('.je-ask-dim, .je-ask-native-label-off').forEach(n => n.classList.remove('je-ask-dim', 'je-ask-native-label-off'));
    }

    /**
     * Starts the season-page request controls (behind the phase-3 flag).
     * @returns {void}
     */
    function initialize() {
        if (started || !JE.arrAsk?.enabled()) return;
        const episodes = JE.internals?.arrStatusEpisodes;
        if (!episodes?.extend) return;
        started = true;
        episodes.extend({ chip, drawn, decorate, clear });
        // An ask made elsewhere (the request sheet, the series page) changes this season's states.
        unsubscribe = JE.arrAsk.onChange(() => {
            if (!season) return;
            const again = { ...season, loading: true, generation: ++generation };
            season = again;
            load(again);
        });
    }

    JE.session?.onUserChange?.('arr-ask-episodes', () => {
        closeDialog();
        season = null;
        local.clear();
        searched.clear();
        bannerSearched = null;
        busy.clear();
        generation++;
    });

    JE.internals = JE.internals || {};
    JE.internals.arrAskEpisodes = { initialize, chip, drawn, decorate, clear, isMissing, requestState, getEpisodes, searchEpisode, searchBanner, openDetails, closeDialog, stop: () => { if (unsubscribe) unsubscribe(); } };
    JE.initializeArrAskEpisodes = initialize;
})(window.JellyfinEnhanced);
