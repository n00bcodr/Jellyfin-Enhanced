/**
 * @file Requests & downloads, phase 3: smart actions on Jellyfin details pages, under the status
 * block. Series pages get **Get Season N** (the first season with aired episodes and nothing of it
 * here), **Get missing episodes** (the aired episodes missing from seasons that are partly here) and
 * **More…** (the request sheet); a movie in the library gets **Get 4K** for people who may ask for
 * 4K when no 4K copy is here. Season and episode pages are left to the season rows. Everything is
 * hidden for Watchers and when the request feature is off; when a person's asks wait for an OK the
 * buttons say "Ask {contact} for …". After an ask the button turns into the state (Waiting for OK /
 * Asked!). A missing episode's page (and, for administrators, a series with nothing of it) that is
 * monitored and missing for a long while gets **Search**: an administrator's runs the arr's search
 * at once and says what it found; everyone else asks (the request backend turns it into a search). Collection pages are handed to ask-collection.js. Called by status-details.js after each
 * status read (JE.internals.arrAskActions.attachDetails).
 */
(function (JE) {
    'use strict';

    const SURFACE = 'details';
    /** Seasons whose episodes "Get missing episodes" reads at most (one status read each, on tap). */
    const MAX_SEASONS = 10;
    /** How long a "Waiting for OK" / "Asked!" state shown after an ask outlives the page's own data. */
    const DONE_TTL_MS = 10 * 60 * 1000;
    const MISSING_STAGES = new Set(['looking', 'notHere']);

    /** How long an administrator's Search outcome stays in the place of its button. */
    const SEARCHED_TTL_MS = 2 * 60 * 1000;
    /** @type {Map<string, {chip: string, tone: string, at: number, ttl?: number}>} key|action → state after an ask or a Search */
    const done = new Map();
    /** @type {Map<string, {at: number, promise: Promise<Object|null>}>} quota by media type, briefly */
    const quotas = new Map();
    const busy = new Set();
    let generation = 0;
    let listening = false;

    /**
     * Translates (shared helper).
     * @param {string} key en.json key.
     * @param {Object} [params] Parameters.
     * @returns {string} Text.
     */
    function tr(key, params) {
        return JE.arrStatus ? JE.arrStatus.tr(key, params) : key;
    }

    /**
     * The details-page item id from the URL hash.
     * @returns {string|null} Id.
     */
    function itemIdFromHash() {
        const hash = window.location.hash || '';
        if (!/details/i.test(hash)) return null;
        try {
            return new URLSearchParams(hash.split('?')[1] || '').get('id');
        } catch {
            return null;
        }
    }

    /**
     * The caller's allowance for a media type (shared for 30 s; dropped after an ask).
     * @param {'movie'|'tv'} type Media type.
     * @returns {Promise<Object|null>} Quota.
     */
    function quota(type) {
        const entry = quotas.get(type);
        if (entry && Date.now() - entry.at < 30000) return entry.promise;
        const promise = JE.arrAsk.quota(type);
        quotas.set(type, { at: Date.now(), promise });
        return promise;
    }

    /**
     * True when an episode is simply missing (nothing is under way and nothing is wrong).
     * @param {Object} ep Episode status.
     * @returns {boolean} Missing.
     */
    function isMissing(ep) {
        const shared = JE.internals?.arrAskEpisodes?.isMissing;
        if (typeof shared === 'function') return shared(ep);
        if (!ep || !MISSING_STAGES.has(ep.stage) || ep.attention) return false;
        return ep.reason?.code !== 'service_down' && ep.reason?.code !== 'failed';
    }

    /**
     * Missing aired episodes of a season summary that are known to be missing (not "unknown").
     * @param {Object} summary Season summary.
     * @returns {number} Count.
     */
    function missingOf(summary) {
        const missing = summary?.missing || 0;
        return Math.max(0, missing - Math.min(missing, summary?.unknown || 0));
    }

    /**
     * What a series page offers: the season to get whole, the seasons with missing episodes, and
     * the request sheet's view of the seasons.
     * @param {Object} status Series status.
     * @returns {{nextSeason: number|null, partial: Array<Object>, missing: number, seasons: Array, latestSeason: number|null, upcomingSeason: number|null}} Plan.
     */
    function seriesPlan(status) {
        const seasons = (status.seasons || []).filter(s => Number.isInteger(s?.season) && s.season > 0).sort((a, b) => a.season - b.season);
        const whole = seasons.find((s) => {
            const m = s.summary || {};
            // Nothing of it here or on its way: missing (monitored) or simply not fetched (unmonitored).
            return m.aired > 0 && !m.ready && !m.downloading && !m.almostReady && !m.attention && !(m.unknown > 0) && !['asked', 'approved'].includes(s.stage);
        });
        const partial = seasons.filter(s => s !== whole && s.itemId && missingOf(s.summary) > 0);
        const aired = seasons.filter(s => (s.summary?.aired || 0) > 0);
        const owned = seasons.filter(s => (s.summary?.ready || 0) > 0 || (s.summary?.downloading || 0) > 0 || (s.summary?.almostReady || 0) > 0);
        const lastOwned = owned.length ? owned[owned.length - 1].season : 0;
        const upcoming = seasons.find(s => s.season > lastOwned && !(s.summary?.ready > 0));
        return {
            nextSeason: whole ? whole.season : null,
            partial,
            missing: partial.reduce((n, s) => n + missingOf(s.summary), 0),
            seasons: seasons.map(s => ({ season: s.season, episodes: s.summary?.aired || 0, have: s.summary?.ready || 0, status: s.stage })),
            latestSeason: aired.length ? aired[aired.length - 1].season : null,
            upcomingSeason: upcoming ? upcoming.season : (lastOwned > 0 ? lastOwned + 1 : null)
        };
    }

    /**
     * Removes this surface's actions from a page.
     * @param {ParentNode} [root] Where.
     * @returns {void}
     */
    function clear(root) {
        (root || document).querySelectorAll(`.je-ask-actions[data-je-ask-surface="${SURFACE}"]`).forEach(n => n.remove());
    }

    /**
     * Details page: the smart actions for the status shown (null status: remove them, and give
     * collection pages their gaps block). Called by status-details.js after each status read.
     * @param {HTMLElement|null} page Details page.
     * @param {Object|null} status Item status.
     * @param {Object} [ctx] Response context.
     * @returns {void}
     */
    function attachDetails(page, status, ctx) {
        if (!page) return;
        const gen = ++generation;
        listen();
        if (!JE.arrAsk?.enabled()) {
            clear(page);
            JE.internals?.arrAskCollection?.clear?.(page);
            return;
        }
        if (!status) {
            clear(page);
            JE.internals?.arrAskCollection?.attach?.(page, itemIdFromHash());
            return;
        }
        JE.internals?.arrAskCollection?.clear?.(page);
        if (status.kind !== 'series' && status.kind !== 'movie' && status.kind !== 'episode') {
            clear(page);
            return;
        }
        JE.arrAsk.me().then(async (caps) => {
            if (gen !== generation) return;
            if (!caps?.canRequest) {
                clear(page);
                return;
            }
            const box = status.kind === 'series' ? await seriesActions(page, status, ctx, caps, gen)
                : status.kind === 'episode' ? episodeActions(status, caps)
                    : await movieActions(page, status, caps, gen);
            if (gen !== generation) return;
            place(page, box);
        });
    }

    /**
     * Puts the actions box under the status block (or at the top of the details section), replacing
     * the previous one; keeps the focus on the same action when it is redrawn.
     * @param {HTMLElement} page Page.
     * @param {HTMLElement|null} box Actions, or null for none.
     * @returns {void}
     */
    function place(page, box) {
        const old = page.querySelector(`.je-ask-actions[data-je-ask-surface="${SURFACE}"]`);
        const focused = old && old.contains(document.activeElement) ? document.activeElement.dataset?.jeFocus : null;
        if (!box) {
            if (old) old.remove();
            return;
        }
        if (old && old.dataset.sig === box.dataset.sig) return;
        if (old) {
            old.replaceWith(box);
        } else {
            const block = page.querySelector('.je-arr-status[data-je-arr-surface="details"]');
            const anchor = JE.internals?.arrStatusDetails?.anchorOf?.(page) || page.querySelector('.detailPagePrimaryContent');
            if (block && block.parentNode) block.insertAdjacentElement('afterend', box);
            else if (anchor) anchor.insertBefore(box, anchor.firstChild);
            else return;
        }
        if (focused) {
            const again = box.querySelector(`[data-je-focus="${focused}"]`);
            if (again) {
                if (again.tabIndex < 0 && again.tagName !== 'BUTTON') again.tabIndex = -1;
                again.focus();
            }
        }
    }

    /**
     * A new actions box.
     * @param {Object} caps Capabilities.
     * @returns {HTMLElement} Box.
     */
    function actionsBox(caps) {
        const box = JE.arrStatus.el('div', 'je-ask-actions');
        box.dataset.jeAskSurface = SURFACE;
        box.setAttribute('role', 'group');
        box.setAttribute('aria-label', tr('arr_actions_label'));
        if (JE.internals?.arrAskSheetStyles?.isLight?.()) box.classList.add('je-ask-light');
        JE.internals?.arrAskSheetStyles?.ensure?.();
        box.dataset.contact = JE.arrAsk.contact(caps);
        return box;
    }

    /**
     * An action button, or the state chip when it was asked for already on this page.
     * @param {string} doneKey key|action.
     * @param {string} iconName Icon.
     * @param {string} text Label.
     * @param {Function} onClick Handler (gets the button).
     * @param {boolean} [secondary] Outline look.
     * @returns {HTMLElement} Button or chip.
     */
    function action(doneKey, iconName, text, onClick, secondary) {
        const S = JE.arrStatus;
        const state = done.get(doneKey);
        if (state && Date.now() - state.at < (state.ttl || DONE_TTL_MS)) {
            const chip = S.el('span', `je-arr-chip je-arr-tone-${state.tone}`, state.chip);
            chip.dataset.jeFocus = doneKey;
            chip.tabIndex = -1;
            return chip;
        }
        const b = S.el('button', `je-ask-action${secondary ? ' je-ask-action-secondary' : ''}`);
        b.type = 'button';
        b.dataset.jeFocus = doneKey;
        b.appendChild(S.icon(iconName, 'je-ask-action-icon'));
        b.appendChild(S.el('span', 'je-ask-action-text', text));
        if (busy.has(doneKey)) {
            b.disabled = true;
            b.setAttribute('aria-busy', 'true');
            b.querySelector('.je-ask-action-text').textContent = tr(iconName === 'search' ? 'arr_ask_searching' : 'arr_ask_asking');
        }
        b.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (busy.has(doneKey)) return;
            onClick(b);
        });
        return b;
    }

    /**
     * The session's sign-in epoch (0 without the session helper).
     * @returns {number} Epoch.
     */
    function sessionEpoch() {
        return JE.session?.getEpoch ? JE.session.getEpoch() : 0;
    }

    /**
     * Runs one ask from an action button: busy look, the answer as a toast, and the button turned
     * into the state chip when the ask was recorded.
     * @param {HTMLButtonElement} button Button.
     * @param {string} doneKey key|action.
     * @param {Function} makeInput Async function returning the mutation input (null: nothing to ask).
     * @param {'movie'|'tv'} type Media type (quota words).
     * @returns {Promise<void>}
     */
    async function run(button, doneKey, makeInput, type) {
        busy.add(doneKey);
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        const text = button.querySelector('.je-ask-action-text');
        const label = text ? text.textContent : '';
        if (text) text.textContent = tr('arr_ask_asking');
        // The input is prepared from this session's reads: a sign-out (and someone else's sign-in)
        // before it is sent drops the ask instead of sending it as the next person.
        const started = sessionEpoch();
        let result = null;
        try {
            const input = await makeInput();
            if (sessionEpoch() !== started) result = { stale: true };
            else if (input) result = await JE.arrAsk.ask(input);
            else result = { ok: true, state: 'nothing' };
        } catch {
            result = { ok: false, state: 'failed' };
        } finally {
            busy.delete(doneKey);
        }
        if (result.stale) return;
        const caps = await JE.arrAsk.me();
        const allowance = result.state === 'quota' ? await JE.arrAsk.quota(type) : null;
        const words = JE.arrAsk.describe(result, caps, allowance);
        JE.arrAsk.toast(words.text);
        quotas.clear();
        const recorded = (result.ok || result.state === 'unknown') && !!words.chip;
        if (recorded) done.set(doneKey, { chip: words.chip, tone: words.tone, at: Date.now() });
        if (!document.contains(button)) return;
        if (recorded) {
            // The button becomes the state; keyboard and TV focus stay on it.
            const chip = action(doneKey, '', '', () => {});
            const focused = document.activeElement === button;
            const box = button.closest('.je-ask-actions');
            button.replaceWith(chip);
            if (focused) chip.focus();
            if (box) box.dataset.sig = signature(box);
            return;
        }
        button.disabled = false;
        button.removeAttribute('aria-busy');
        if (text) text.textContent = label;
    }

    /**
     * Runs an administrator's Search from an action button: Searching…, then what it found (a toast,
     * and the outcome in the button's place for a couple of minutes).
     * @param {HTMLButtonElement} button Button.
     * @param {string} doneKey key|action.
     * @param {string} key Title key in scope.
     * @param {string} instanceId Instance (JE.arrAsk.searchInstance).
     * @returns {Promise<void>}
     */
    async function runSearch(button, doneKey, key, instanceId) {
        busy.add(doneKey);
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        const text = button.querySelector('.je-ask-action-text');
        const label = text ? text.textContent : '';
        if (text) text.textContent = tr('arr_ask_searching');
        let result;
        try {
            result = await JE.arrAsk.adminSearch(key, instanceId);
        } catch {
            result = { ok: false, state: 'failed', chip: '', text: tr('arr_manage_search_failed', { message: '' }), tone: 'attention' };
        } finally {
            busy.delete(doneKey);
        }
        JE.arrAsk.toast(result.text);
        if (result.chip) done.set(doneKey, { chip: result.chip, tone: result.tone, at: Date.now(), ttl: SEARCHED_TTL_MS });
        if (!document.contains(button)) return;
        if (result.chip) {
            const chip = action(doneKey, '', '', () => {});
            const focused = document.activeElement === button;
            const box = button.closest('.je-ask-actions');
            button.replaceWith(chip);
            if (focused) chip.focus();
            if (box) box.dataset.sig = signature(box);
            return;
        }
        button.disabled = false;
        button.removeAttribute('aria-busy');
        if (text) text.textContent = label;
    }

    /**
     * A missing episode's own page (Jellyfin's row for a missing episode opens it; on TV that is how
     * an episode is asked for): Get it, or Ask {contact}. Missing for a long while (monitored, nothing
     * grabbed): Search instead (an administrator's runs the arr's search; everyone else asks).
     * @param {Object} status Episode status.
     * @param {Object} caps Capabilities.
     * @returns {HTMLElement|null} Box, or null when the episode isn't simply missing.
     */
    function episodeActions(status, caps) {
        const m = /^(.*):s(\d+):e(\d+)$/.exec(String(status.key || ''));
        const missing = JE.internals?.arrAskEpisodes?.isMissing ? JE.internals.arrAskEpisodes.isMissing(status) : false;
        if (!m || !missing) return null;
        const key = m[1];
        const season = Number(m[2]);
        const episode = Number(m[3]);
        const box = actionsBox(caps);
        const contact = JE.arrAsk.contact(caps);
        const ask = (b, doneKey) => run(b, doneKey, async () => JE.arrAsk.episodesInput(key, [{ season, episode }]), 'tv');
        if (JE.arrStatus.searchable?.(status)) {
            const doneKey = `${key}|s${season}e${episode}|search`;
            const instanceId = JE.arrAsk.searchInstance(caps, status, status.key);
            const text = caps.asksFirst ? tr('arr_actions_ask_search', { contact }) : tr('arr_ask_search');
            box.appendChild(action(doneKey, 'search', text, (b) => (instanceId ? runSearch(b, doneKey, status.key, instanceId) : ask(b, doneKey))));
        } else {
            const doneKey = `${key}|s${season}e${episode}`;
            const text = caps.asksFirst ? tr('arr_actions_ask_episode', { contact }) : tr('arr_ask_get_it');
            box.appendChild(action(doneKey, 'add', text, (b) => ask(b, doneKey)));
        }
        box.dataset.sig = signature(box);
        return box;
    }

    /**
     * The series page's actions.
     * @param {HTMLElement} page Page.
     * @param {Object} status Series status.
     * @param {Object} ctx Response context.
     * @param {Object} caps Capabilities.
     * @param {number} gen Generation of this render.
     * @returns {Promise<HTMLElement|null>} Box.
     */
    async function seriesActions(page, status, ctx, caps, gen) {
        const plan = seriesPlan(status);
        const contact = JE.arrAsk.contact(caps);
        const ask = caps.asksFirst;
        const box = actionsBox(caps);
        const key = JE.arrAsk.seriesKey(status.key);
        let firstCost = null;
        if (plan.nextSeason != null) {
            const doneKey = `${key}|season:${plan.nextSeason}`;
            box.appendChild(action(doneKey, 'download', ask ? tr('arr_actions_ask_season', { contact, season: plan.nextSeason }) : tr('arr_actions_get_season', { season: plan.nextSeason }),
                (b) => run(b, doneKey, async () => JE.arrAsk.seasonsInput(key, [plan.nextSeason]), 'tv')));
            firstCost = JE.arrAsk.seasonsInput(key, [plan.nextSeason]);
        }
        if (plan.missing > 0) {
            const doneKey = `${key}|missing`;
            box.appendChild(action(doneKey, 'playlist_add', ask ? tr('arr_actions_ask_missing', { contact }) : tr('arr_actions_get_missing'),
                (b) => run(b, doneKey, () => missingInput(key, plan.partial), 'tv'), plan.nextSeason != null));
            if (!firstCost) firstCost = { scope: 'episodes', episodes: new Array(plan.missing).fill(0) };
        }
        // The whole series is monitored and still has nothing, long after it was added: Search. An
        // administrator's runs the arr's search for it right away; everyone else asks for the
        // seasons that aren't here (the request backend turns that into a search).
        if (JE.arrStatus.searchable?.(status)) {
            const searchFrom = JE.arrAsk.searchInstance(caps, status, key);
            const wanted = plan.seasons.filter(s => s.episodes > 0 && s.have < s.episodes).map(s => s.season);
            if (searchFrom || wanted.length) {
                const doneKey = `${key}|search`;
                const label = !searchFrom && ask ? tr('arr_actions_ask_search', { contact }) : tr('arr_ask_search');
                box.appendChild(action(doneKey, 'search', label, (b) => (searchFrom ? runSearch(b, doneKey, key, searchFrom)
                    : run(b, doneKey, async () => JE.arrAsk.seasonsInput(key, wanted), 'tv')), plan.nextSeason != null || plan.missing > 0));
            }
        }
        const more = action(`${key}|more`, 'more_horiz', tr('arr_actions_more'), (b) => openSheet(b, status, plan), true);
        more.setAttribute('aria-label', tr('arr_actions_more_label', { name: page.querySelector('.itemName, h1, h3.itemName')?.textContent?.trim() || '' }).trim());
        box.appendChild(more);
        if (firstCost) {
            const allowance = await quota('tv');
            if (gen !== generation) return null;
            const line = JE.internals?.arrAskSheet?.costLine?.(firstCost, caps, allowance);
            if (line?.text) box.appendChild(JE.arrStatus.el('span', 'je-ask-action-cost', line.text));
        }
        box.dataset.sig = signature(box);
        return box;
    }

    /**
     * The input of "Get missing episodes": reads the seasons with missing episodes (their own
     * status) and names every missing aired episode.
     * @param {string} key Series key.
     * @param {Array<Object>} seasons Seasons with missing episodes (with item ids).
     * @returns {Promise<Object|null>} Input, or null when nothing turned out to be missing.
     */
    async function missingInput(key, seasons) {
        const reads = await Promise.all(seasons.slice(0, MAX_SEASONS).map(s => JE.arrStatus.fetchItem(s.itemId).catch(() => null)));
        const episodes = [];
        reads.forEach((data, i) => {
            const season = seasons[i].season;
            for (const ep of data?.items?.[0]?.episodes || []) {
                if (isMissing(ep)) episodes.push({ season, episode: ep.episode });
            }
        });
        return episodes.length ? JE.arrAsk.episodesInput(key, episodes) : null;
    }

    /**
     * Opens the request sheet for the series: name, year and poster from the Jellyfin item; the
     * seasons from the status (and TMDB's season list when the status has none).
     * @param {HTMLButtonElement} button The More… button.
     * @param {Object} status Series status.
     * @param {Object} plan Series plan.
     * @returns {Promise<void>}
     */
    async function openSheet(button, status, plan) {
        if (!JE.arrAskSheet) return;
        const item = await loadItem(status.itemId);
        let seasons = plan.seasons;
        let latest = plan.latestSeason;
        let upcoming = plan.upcomingSeason;
        if (!seasons.length) {
            const tmdb = await tmdbSeasons(item?.ProviderIds?.Tmdb);
            seasons = tmdb.seasons;
            latest = tmdb.latest;
            upcoming = tmdb.upcoming;
        }
        const result = await JE.arrAskSheet.open({
            key: JE.arrAsk.seriesKey(status.key),
            kind: 'series',
            name: item?.Name || '',
            year: Number.isInteger(item?.ProductionYear) ? item.ProductionYear : undefined,
            poster: posterOf(item),
            seasons,
            latestSeason: latest,
            nextSeason: upcoming
        }, { opener: button });
        if (result) quotas.clear();
    }

    /**
     * The Jellyfin item (cached by JE's helpers), or null.
     * @param {string} itemId Item id.
     * @returns {Promise<Object|null>} Item.
     */
    async function loadItem(itemId) {
        if (!itemId) return null;
        try {
            if (typeof JE.helpers?.getItemCached === 'function') return await JE.helpers.getItemCached(itemId);
            return await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);
        } catch {
            return null;
        }
    }

    /**
     * The item's primary image URL, or undefined.
     * @param {Object|null} item Item.
     * @returns {string|undefined} URL.
     */
    function posterOf(item) {
        if (!item?.Id || !item?.ImageTags?.Primary) return undefined;
        const path = `/Items/${encodeURIComponent(item.Id)}/Images/Primary?maxHeight=240&tag=${encodeURIComponent(item.ImageTags.Primary)}`;
        return typeof ApiClient?.getUrl === 'function' ? ApiClient.getUrl(path) : path;
    }

    /**
     * A series' seasons from JE's TMDB proxy, for series the status has no season list for.
     * @param {string|undefined} tmdbId TMDB id.
     * @returns {Promise<{seasons: Array, latest: number|null, upcoming: number|null}>} Seasons.
     */
    function tmdbSeasons(tmdbId) {
        return JE.arrAsk.tmdbSeasons(tmdbId);
    }

    /**
     * A movie in the library: Get 4K for people who may ask for 4K when no 4K copy is here.
     * @param {HTMLElement} page Page.
     * @param {Object} status Movie status.
     * @param {Object} caps Capabilities.
     * @param {number} gen Generation.
     * @returns {Promise<HTMLElement|null>} Box.
     */
    async function movieActions(page, status, caps, gen) {
        if (!caps.can4kMovies || !status.itemId) return null;
        const item = await loadItem(status.itemId);
        if (gen !== generation || !item || has4k(item)) return null;
        const box = actionsBox(caps);
        const contact = JE.arrAsk.contact(caps);
        const key = status.key;
        const doneKey = `${key}|4k`;
        box.appendChild(action(doneKey, '4k', caps.asksFirst ? tr('arr_actions_ask_4k', { contact }) : tr('arr_actions_get_4k'),
            (b) => run(b, doneKey, async () => JE.arrAsk.movieInput(key, '4k'), 'movie'), true));
        box.dataset.sig = signature(box);
        return box;
    }

    /**
     * True when any version of the item has a 4K video stream.
     * @param {Object} item Jellyfin item.
     * @returns {boolean} Has 4K.
     */
    function has4k(item) {
        const sources = Array.isArray(item?.MediaSources) ? item.MediaSources : [];
        return sources.some(source => (source.MediaStreams || []).some(s => s.Type === 'Video' && ((s.Width || 0) >= 3200 || (s.Height || 0) >= 2000)));
    }

    /**
     * What a box shows (it is replaced only when this changes, so focus and hover stay put).
     * @param {HTMLElement} box Box.
     * @returns {string} Signature.
     */
    function signature(box) {
        return [...box.children].map(n => `${n.tagName}:${n.textContent}:${n.disabled ? 1 : 0}`).join('|');
    }

    /**
     * Follows asks made elsewhere (the sheet, season rows) so the quota and states stay true.
     * @returns {void}
     */
    function listen() {
        if (listening || !JE.arrAsk?.onChange) return;
        listening = true;
        JE.arrAsk.onChange(() => quotas.clear());
    }

    JE.session?.onUserChange?.('arr-ask-actions', () => {
        done.clear();
        quotas.clear();
        busy.clear();
        generation++;
    });

    JE.internals = JE.internals || {};
    JE.internals.arrAskActions = { attachDetails, clear, seriesPlan, has4k, missingInput, tmdbSeasons, runSearch };
})(window.JellyfinEnhanced);
