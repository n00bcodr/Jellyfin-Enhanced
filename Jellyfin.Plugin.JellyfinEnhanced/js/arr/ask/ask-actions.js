/**
 * @file Requests & downloads, phase 3: smart actions on Jellyfin details pages, under the status
 * block. Series pages get **Get Season N** (the first season with aired episodes and nothing of it
 * here), **Get missing episodes** (the aired episodes missing for a long while from seasons that are
 * partly here; episodes the arr is looking for right now offer nothing) and **More…** (the request
 * sheet); a movie in the library gets **Get 4K** for people who may ask for
 * 4K when no 4K copy is here. Season and episode pages are left to the season rows. Everything is
 * hidden for Watchers and when the request feature is off; when a person's asks wait for an OK the
 * buttons say "Ask {contact} for …". After an ask the button turns into the state (Waiting for OK /
 * Asked!). A missing episode's page (and, for administrators, a series with nothing of it) that is
 * monitored and missing for a long while gets **Search**: an administrator's runs the arr's search
 * at once and says what it found; everyone else asks (the request backend turns it into a search). When the
 * title can't be asked for right now (JE.arrAsk.check: e.g. the drive it would land on is nearly full) the ask
 * buttons give way to one line saying so ("Paused: storage full"; where and how much is free for
 * administrators), while an administrator's Search stays. Collection pages are handed to ask-collection.js.
 * Called by status-details.js after each status read (JE.internals.arrAskActions.attachDetails).
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
    /** The owner of each action button's latest press (D46S2-R11): run() asks for it. Weak: a button that goes, goes. */
    const presses = new WeakMap();
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
     * True when a missing episode can be asked for or searched (an episode the arr is looking for right now
     * offers nothing: see JE.internals.arrAskEpisodes.offerable).
     * @param {Object} ep Episode status.
     * @returns {boolean} Offerable.
     */
    function offerable(ep) {
        const shared = JE.internals?.arrAskEpisodes?.offerable;
        if (typeof shared === 'function') return shared(ep);
        return isMissing(ep) && (ep.stage === 'notHere' || !!JE.arrStatus?.searchable?.(ep));
    }

    /**
     * True when a missing episode can be asked for with Get: nobody is fetching it (see
     * JE.internals.arrAskEpisodes.askable).
     * @param {Object} ep Episode status.
     * @returns {boolean} Askable.
     */
    function askable(ep) {
        const shared = JE.internals?.arrAskEpisodes?.askable;
        if (typeof shared === 'function') return shared(ep);
        return isMissing(ep) && ep.stage === 'notHere';
    }

    /**
     * Missing aired episodes of a season summary that are missing for a long while (monitored, nothing grabbed
     * long after they were wanted: Search). Episodes the arr is looking for right now don't count.
     * @param {Object} summary Season summary.
     * @returns {number} Count.
     */
    function longMissingOf(summary) {
        return Math.max(0, summary?.longMissing || 0);
    }

    /**
     * Aired episodes of a season summary nobody is fetching (not monitored, or not in the arr at all): the ones Get
     * asks for. Monitored ones are missing (Search once missing for a long while) or on their way.
     * @param {Object} summary Season summary.
     * @returns {number} Count.
     */
    function notFetchedOf(summary) {
        const m = summary || {};
        return Math.max(0, (m.aired || 0) - (m.ready || 0) - (m.downloading || 0) - (m.almostReady || 0) - (m.missing || 0));
    }

    /**
     * True when something of a season is here, on its way or being looked for (ready, downloading, almost ready, or
     * monitored and missing).
     * @param {Object} summary Season summary.
     * @returns {boolean} Partly here.
     */
    function partlyHere(summary) {
        const m = summary || {};
        return (m.ready || 0) + (m.downloading || 0) + (m.almostReady || 0) + (m.missing || 0) > 0;
    }

    /**
     * True when a season with nothing of it here has something to get: aired episodes nobody is fetching. Episodes
     * missing for a long while get Search instead (a request may already have sent them), and a season the arr is
     * looking for right now has nothing.
     * @param {Object} summary Season summary.
     * @returns {boolean} Offerable.
     */
    function seasonOfferable(summary) {
        return notFetchedOf(summary) > 0;
    }

    /**
     * What a series page offers: the season to get whole, the seasons with missing episodes, and
     * the request sheet's view of the seasons.
     * @param {Object} status Series status.
     * @returns {{nextSeason: number|null, partial: Array<Object>, missing: number, seasons: Array, latestSeason: number|null, upcomingSeason: number|null, askedSeasons: Array<number>}} Plan.
     */
    function seriesPlan(status) {
        const seasons = (status.seasons || []).filter(s => Number.isInteger(s?.season) && s.season > 0).sort((a, b) => a.season - b.season);
        // Seasons the viewer already asked for (still "looking" once Sonarr has them) aren't offered again.
        const asked = new Set(Array.isArray(status.askedSeasons) ? status.askedSeasons : []);
        const whole = seasons.find((s) => {
            const m = s.summary || {};
            // Nothing of it here or on its way: simply not fetched (unmonitored) or missing for a long while; a
            // season the arr is looking for right now has nothing to ask for.
            return m.aired > 0 && !m.ready && !m.downloading && !m.almostReady && !m.attention && !(m.unknown > 0) && !['asked', 'approved'].includes(s.stage)
                && !asked.has(s.season) && seasonOfferable(m);
        });
        // Seasons partly here with episodes nobody is fetching (missing for a long while: Search; looked for now: nothing).
        // Partly here: something of it ready, on its way or looked for. A season with nothing of it is a whole season to
        // get (on a title that isn't in the library every season has a page id, so the id alone doesn't say it's here).
        const partial = seasons.filter(s => s !== whole && !asked.has(s.season) && s.itemId && partlyHere(s.summary) && notFetchedOf(s.summary) > 0);
        // Seasons with episodes missing for a long while: Search (never Get: a request may already have sent them),
        // asked-for seasons included.
        const searchable = seasons.filter(s => longMissingOf(s.summary) > 0);
        const aired = seasons.filter(s => (s.summary?.aired || 0) > 0);
        const owned = seasons.filter(s => (s.summary?.ready || 0) > 0 || (s.summary?.downloading || 0) > 0 || (s.summary?.almostReady || 0) > 0);
        const lastOwned = owned.length ? owned[owned.length - 1].season : 0;
        const upcoming = seasons.find(s => s.season > lastOwned && !(s.summary?.ready > 0));
        return {
            nextSeason: whole ? whole.season : null,
            partial,
            missing: partial.reduce((n, s) => n + notFetchedOf(s.summary), 0),
            longMissing: searchable.reduce((n, s) => n + longMissingOf(s.summary), 0),
            searchSeasons: searchable.map(s => s.season),
            seasons: seasons.map(s => ({ season: s.season, itemId: s.itemId || null, episodes: s.summary?.aired || 0, have: s.summary?.ready || 0, status: s.stage })),
            latestSeason: aired.length ? aired[aired.length - 1].season : null,
            upcomingSeason: upcoming ? upcoming.season : (lastOwned > 0 ? lastOwned + 1 : null),
            askedSeasons: [...asked]
        };
    }

    /**
     * Removes this surface's actions from a page.
     * @param {ParentNode} [root] Where.
     * @returns {void}
     */
    function clear(root) {
        (root || document).querySelectorAll(`.je-ask-actions[data-je-ask-surface="${SURFACE}"]`).forEach(n => n.remove());
        // The page of a title that isn't in the library is told too: it may hold a box out of the page
        // while its action row is drawn anew.
        if (root) JE.internals?.nativeDetails?.placeActions?.(root, null, null);
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
        // A season of a title that isn't in the library (native details) gets Get Season N; library
        // season pages are left to the season rows.
        const absentSeason = status.kind === 'season' && isAbsent(status);
        if (status.kind !== 'series' && status.kind !== 'movie' && status.kind !== 'episode' && !absentSeason) {
            clear(page);
            return;
        }
        JE.arrAsk.me().then(async (caps) => {
            if (gen !== generation) return;
            if (!JE.arrAsk.canAsk(caps, status.kind === 'movie' ? 'movie' : 'series')) {
                clear(page);
                return;
            }
            // The page of an episode that isn't in the library shows TMDB's episode of that number: held when the arr
            // the ask goes to numbers its season differently.
            const held = status.kind === 'episode' && isAbsent(status) && offerable(status) ? await episodeHeld(status) : false;
            if (gen !== generation) return;
            let box = status.kind === 'series' ? await seriesActions(page, status, ctx, caps, gen)
                : status.kind === 'episode' ? (held ? heldBox(caps) : episodeActions(status, caps))
                    : status.kind === 'season' ? await seasonActions(status, caps, gen)
                        : movieActions(page, status, caps, gen);
            if (gen !== generation) return;
            // Asks (and a family Search, which is an ask or a search on the title's own folder) are checked for this
            // title first: refused right now, the page says why instead of offering a button that can't work. An
            // administrator's Search stays, and is told the same (where and how much is free): the grab may not fit.
            if (box && box.querySelector('[data-je-ask-kind="ask"], [data-je-ask-kind="search"]')) {
                const check = JE.arrAsk.check ? await JE.arrAsk.check(status.key, box.dataset.jeAskVariant || 'standard') : null;
                if (gen !== generation) return;
                if (check && !check.canRequest && check.blocked) {
                    pause(box, check.blocked, caps);
                    // A season that isn't in the library: its episode rows (or Missing banner) say the same right
                    // below, as on a library season page, so a box left with nothing to press would only repeat it.
                    if (absentSeason && !box.querySelector('.je-ask-action')) box = null;
                }
            }
            place(page, box);
        });
    }

    /**
     * Turns a box's ask buttons into the line saying why the title can't be asked for now ("Paused: storage
     * full"); an administrator's Search and More… stay.
     * @param {HTMLElement} box Actions box.
     * @param {Object} block Block (JE.arrAsk.check).
     * @param {Object} caps Capabilities.
     * @returns {void}
     */
    function pause(box, block, caps) {
        const words = JE.arrAsk.blockWords?.(block, caps);
        if (!words) return;
        box.querySelectorAll('[data-je-ask-kind="ask"], .je-ask-action-cost').forEach(n => n.remove());
        const note = JE.arrAsk.pausedNote(words);
        note.dataset.jeFocus = 'paused';
        box.insertBefore(note, box.firstChild);
        box.classList.add('je-ask-actions-paused');
        box.dataset.sig = signature(box);
    }

    /**
     * Puts the actions box under the status block (or at the top of the details section; on the page of
     * a title that isn't in the library, in the native action row), replacing the previous one; keeps
     * the focus on the same action when it is redrawn.
     * @param {HTMLElement} page Page.
     * @param {HTMLElement|null} box Actions, or null for none.
     * @returns {void}
     */
    function place(page, box) {
        const old = page.querySelector(`.je-ask-actions[data-je-ask-surface="${SURFACE}"]`);
        const focused = old && old.contains(document.activeElement) ? document.activeElement.dataset?.jeFocus : null;
        if (box && old && old.dataset.sig === box.dataset.sig) return;
        // The page of a title that isn't in the library puts them in its native action row, in Play's place.
        const native = JE.internals?.nativeDetails?.placeActions?.(page, box, old) === true;
        if (!box) {
            if (old && !native) old.remove();
            return;
        }
        if (!native && old) {
            old.replaceWith(box);
        } else if (!native) {
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
     * @param {'ask'|'search'|'more'} [kind] What the button does: asks (default; paused when the title can't be
     *     asked for now), an administrator's Search (runs whatever the request policy says), or opens the sheet.
     * @returns {HTMLElement} Button or chip.
     */
    function action(doneKey, iconName, text, onClick, secondary, kind) {
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
        b.dataset.jeAskKind = kind || 'ask';
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
            // The press's owner (D46S2-R11): what the button asks or searches is its, and so is what is said after.
            const owner = JE.ownerOf(e);
            if (!owner) return;
            presses.set(b, owner);
            onClick(b, owner);
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
        const owner = presses.get(button);
        if (!owner) return;
        const submitted = JE.captureSubmitted(owner);
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
            else if (input) result = await JE.arrAsk.ask(input, { bound: submitted.bound() });
            else result = { ok: true, state: 'nothing' };
        } catch {
            result = { ok: false, state: 'failed' };
        } finally {
            busy.delete(doneKey);
        }
        // Never sent, or taken after its owner ended: nothing is said (D46S2-R11-8, -9).
        if (result.stale || !submitted.current()) return;
        const caps = await JE.arrAsk.me();
        const allowance = result.state === 'quota' ? await JE.arrAsk.quota(type) : null;
        if (!submitted.current()) return;
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
     * Runs a Search from an action button: Searching…, then what it found (a toast, and the outcome
     * in the button's place for a couple of minutes). An administrator's runs on the instance given;
     * everyone else's runs when requests already sent the title in scope (JE.arrAsk.familySearch),
     * otherwise <paramref name="fallback"/> asks for it instead.
     * @param {HTMLButtonElement} button Button.
     * @param {string} doneKey key|action.
     * @param {string} key Title key in scope.
     * @param {string|null} instanceId Instance (JE.arrAsk.searchInstance), or null for a family Search.
     * @param {Function} [fallback] Asks for it instead (family Search that doesn't apply).
     * @param {Object} [owner] The press's owner (JE.ownerOf(event)): the search carries its binding.
     * @returns {Promise<void>}
     */
    async function runSearch(button, doneKey, key, instanceId, fallback, owner) {
        busy.add(doneKey);
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        const text = button.querySelector('.je-ask-action-text');
        const label = text ? text.textContent : '';
        if (text) text.textContent = tr('arr_ask_searching');
        let result;
        try {
            // The press's owner's write (D46S2-R10-1): its binding goes with the search.
            const bound = JE.captureSubmitted(owner).bound();
            result = instanceId ? await JE.arrAsk.adminSearch(key, instanceId, { bound }) : await JE.arrAsk.familySearch(key, { bound });
        } catch {
            result = { ok: false, state: 'failed', chip: '', text: tr('arr_manage_search_failed', { message: '' }), tone: 'attention' };
        } finally {
            busy.delete(doneKey);
        }
        if (!result) {
            button.disabled = false;
            button.removeAttribute('aria-busy');
            if (text) text.textContent = label;
            if (fallback && JE.effectOwner(owner, 'a Search')) await fallback();
            return;
        }
        // What it found is a page effect (D46S2-R11-8): said only while the press's owner is current.
        if (result.stale || !JE.effectOwner(owner, 'a Search')) {
            button.disabled = false;
            button.removeAttribute('aria-busy');
            if (text) text.textContent = label;
            return;
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
     * grabbed): Search instead (an administrator's runs the arr's search; everyone else's too when
     * requests already sent the episode, otherwise they ask). In Seerr mode (Seerr takes whole seasons) the ask is
     * for the episode's season, and the button says so ("Get Season 2", with the reason under it).
     * @param {Object} status Episode status.
     * @param {Object} caps Capabilities.
     * @returns {HTMLElement|null} Box, or null when the episode isn't simply missing.
     */
    function episodeActions(status, caps) {
        const m = /^(.*):s(\d+):e(\d+)$/.exec(String(status.key || ''));
        // Being looked for right now (monitored, not missing for long yet): nothing to ask for.
        if (!m || !offerable(status)) return null;
        const key = m[1];
        const season = Number(m[2]);
        const episode = Number(m[3]);
        const box = actionsBox(caps);
        const contact = JE.arrAsk.contact(caps);
        const roundedUp = !!JE.arrAsk.seasonsOnly?.(caps);
        const ask = (b, doneKey) => run(b, doneKey, async () => (roundedUp ? required(JE.arrAsk.roundedInput(key, caps, [season])) : JE.arrAsk.episodesInput(key, [{ season, episode }])), 'tv');
        const instanceId = JE.arrStatus.searchable?.(status) ? JE.arrAsk.searchInstance(caps, status, status.key) : null;
        // Seerr mode: someone else's Search that would be an ask (nothing sent for the episode yet) is the season's ask.
        if (JE.arrStatus.searchable?.(status) && !(roundedUp && !instanceId && status.reason?.params?.sent !== '1')) {
            const doneKey = `${key}|s${season}e${episode}|search`;
            // Requests already sent this episode: the Search runs with no new OK (plain "Search" for a Kid too).
            const text = JE.arrAsk.searchAsksFirst(caps, status) ? tr('arr_actions_ask_search', { contact }) : tr('arr_ask_search');
            // Seerr mode: a Search that turns out not to apply never asks for the season behind a "Search" label.
            const fallback = (b) => (roundedUp ? async () => JE.arrAsk.toast(tr('arr_ask_toast_seerr_season')) : () => ask(b, doneKey));
            box.appendChild(action(doneKey, 'search', text, (b, owner) => runSearch(b, doneKey, status.key, instanceId, fallback(b), owner), false, instanceId ? 'search' : 'ask'));
        } else if (roundedUp) {
            const doneKey = JE.arrAsk.wholeSeriesOnly(caps) ? `${key}|series` : `${key}|season:${season}`;
            box.appendChild(action(doneKey, 'download', JE.arrAsk.roundedLabel(caps, [season], caps.asksFirst), (b) => ask(b, doneKey)));
            box.appendChild(JE.arrStatus.el('span', 'je-ask-action-cost je-ask-action-note', JE.arrAsk.roundedNote(caps, [season])));
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
        let note = '';
        const whole = !!JE.arrAsk.wholeSeriesOnly?.(caps);
        const roundedUp = !!JE.arrAsk.seasonsOnly?.(caps);
        // One season at a time (the administrator's option): the missing episodes and Search ask for the first season.
        const one = !!JE.arrAsk.singleSeasonOnly?.(caps);
        const partial = one ? plan.partial.slice(0, 1) : plan.partial;
        if (whole && (plan.nextSeason != null || plan.missing > 0)) {
            // Seerr takes a request for the whole series only (partial requests off): one button that says so.
            const doneKey = `${key}|series`;
            const known = plan.seasons.map(s => s.season);
            box.appendChild(action(doneKey, 'download', JE.arrAsk.roundedLabel(caps, known, ask),
                (b) => run(b, doneKey, () => required(JE.arrAsk.wholeSeriesInput(key, 'standard', known)), 'tv')));
            firstCost = JE.arrAsk.seasonsInput(key, known);
            note = JE.arrAsk.roundedNote(caps, known);
        }
        if (!whole && plan.nextSeason != null) {
            const doneKey = `${key}|season:${plan.nextSeason}`;
            box.appendChild(action(doneKey, 'download', ask ? tr('arr_actions_ask_season', { contact, season: plan.nextSeason }) : tr('arr_actions_get_season', { season: plan.nextSeason }),
                (b) => run(b, doneKey, async () => JE.arrAsk.seasonsInput(key, [plan.nextSeason]), 'tv')));
            firstCost = JE.arrAsk.seasonsInput(key, [plan.nextSeason]);
        }
        if (!whole && roundedUp && plan.missing > 0) {
            // Seerr mode: the missing episodes are asked for as their seasons, and the button names them.
            const seasons = partial.map(s => s.season);
            const doneKey = `${key}|missing|seasons:${seasons.join(',')}`;
            box.appendChild(action(doneKey, 'playlist_add', JE.arrAsk.roundedLabel(caps, seasons, ask),
                (b) => run(b, doneKey, async () => JE.arrAsk.seasonsInput(key, seasons), 'tv'), plan.nextSeason != null));
            if (!firstCost) firstCost = JE.arrAsk.seasonsInput(key, seasons);
            note = JE.arrAsk.roundedNote(caps, seasons);
        } else if (!whole && plan.missing > 0) {
            const doneKey = `${key}|missing|episodes:${partial.map(s => s.season).join(',')}`;
            const words = ask ? tr('arr_actions_ask_missing', { contact }) : tr('arr_actions_get_missing');
            const label = one && plan.partial.length > 1 ? `${words} · ${tr('arr_sheet_season', { season: partial[0].season })}` : words;
            box.appendChild(action(doneKey, 'playlist_add', label,
                (b) => run(b, doneKey, () => missingInput(key, partial), 'tv'), plan.nextSeason != null));
            if (!firstCost) firstCost = { scope: 'episodes', episodes: new Array(partial.reduce((count, s) => count + notFetchedOf(s.summary), 0)).fill(0) };
        }
        // Every episode still to come is monitored and missing for a long while: Search. An administrator's
        // runs the arr's search for it right away; everyone else's runs it again for those episodes when
        // requests already sent them (no new request, no OK), otherwise they ask for the seasons that
        // aren't here (the request backend turns that into a search).
        // A series partly here gets it too for its seasons with episodes missing for a long while.
        if (JE.arrStatus.searchable?.(status) || plan.longMissing > 0) {
            const searchFrom = JE.arrAsk.searchInstance(caps, status, key);
            const all = plan.searchSeasons.length ? plan.searchSeasons : plan.seasons.filter(s => s.episodes > 0 && s.have < s.episodes).map(s => s.season);
            const wanted = one ? all.slice(0, 1) : all;
            if (searchFrom || wanted.length) {
                const doneKey = `${key}|search`;
                const label = !searchFrom && JE.arrAsk.searchAsksFirst(caps, status) ? tr('arr_actions_ask_search', { contact }) : tr('arr_ask_search');
                const askSeasons = (b) => run(b, doneKey, async () => JE.arrAsk.seasonsInput(key, wanted), 'tv');
                box.appendChild(action(doneKey, 'search', label, (b, owner) => runSearch(b, doneKey, key, searchFrom, () => askSeasons(b), owner),
                    plan.nextSeason != null || plan.missing > 0, searchFrom ? 'search' : 'ask'));
            }
        }
        // A series that isn't in the library (native details): the sheet is its Request (it says why when the
        // title can't be asked for now, so it stays when the box is paused).
        const absent = isAbsent(status);
        const more = action(`${key}|more`, absent ? 'add' : 'more_horiz', tr(absent ? 'arr_actions_request' : 'arr_actions_more'), (b, owner) => openSheet(b, status, plan, owner), !absent || plan.nextSeason != null, 'more');
        more.setAttribute('aria-label', tr('arr_actions_more_label', { name: page.querySelector('.itemName, h1, h3.itemName')?.textContent?.trim() || '' }).trim());
        box.appendChild(more);
        if (firstCost) {
            const allowance = await quota('tv');
            if (gen !== generation) return null;
            const line = JE.internals?.arrAskSheet?.costLine?.(firstCost, caps, allowance);
            if (line?.text) box.appendChild(JE.arrStatus.el('span', 'je-ask-action-cost', line.text));
        }
        if (note) box.appendChild(JE.arrStatus.el('span', 'je-ask-action-cost je-ask-action-note', note));
        box.dataset.sig = signature(box);
        return box;
    }

    /**
     * True for the status of a page of a title that isn't in the library (native details): its
     * item id is a synthetic page id, never a library item.
     * @param {Object} status Status.
     * @returns {boolean} Absent.
     */
    function isAbsent(status) {
        return !!status?.itemId && !!JE.titleDetails?.isSynthetic?.(status.itemId);
    }

    /**
     * True when the page of an episode that isn't in the library is held: the page shows TMDB's episode with this
     * number, and the arr a request names numbers the season differently (JE.arrAsk.episodeNumbering), so Get it or
     * Search could reach another episode than the one described. Read from the season's status and rows (by the
     * season page's id); false when they can't be read or can't be compared.
     * @param {Object} status Episode status.
     * @returns {Promise<boolean>} Held.
     */
    async function episodeHeld(status) {
        const parts = JE.titleDetails?.parse?.(status.itemId);
        const seasonId = parts?.kind === 'episode' ? JE.titleDetails.syntheticId?.('season', parts.tmdbId, parts.season) : null;
        if (!seasonId || !JE.arrAsk.episodeNumbering) return false;
        const language = (navigator.language || 'en').split('-')[0];
        const [season, rows] = await Promise.all([
            Promise.resolve(JE.arrStatus.fetchItem(seasonId)).then(answer => answer?.items?.[0] || null, () => null),
            JE.arrAsk.call(`/acquire/requests/season/${encodeURIComponent(seasonId)}?language=${encodeURIComponent(language)}`).then(answer => (answer.status === 200 ? answer.body?.rows || null : null), () => null)
        ]);
        return JE.arrAsk.episodeNumbering(season?.episodes, rows).state === 'conflict';
    }

    /**
     * The actions of a held episode page ({@link episodeHeld}): the line saying why it can't be asked for on its own.
     * @param {Object} caps Capabilities.
     * @returns {HTMLElement} Box.
     */
    function heldBox(caps) {
        const box = actionsBox(caps);
        const text = tr('arr_ask_numbering_text');
        const note = JE.arrAsk.pausedNote({ chip: tr('arr_ask_numbering_chip'), text, detail: text });
        const glyph = note.querySelector('.je-ask-paused-icon');
        if (glyph) glyph.textContent = 'format_list_numbered';
        note.classList.add('je-ask-numbering-note');
        note.dataset.jeFocus = 'numbering';
        box.appendChild(note);
        box.dataset.sig = signature(box);
        return box;
    }

    /**
     * The season page of a title that isn't in the library: Get Season N while the season has aired
     * episodes and nothing of it is here, asked for or on its way.
     * @param {Object} status Season status.
     * @param {Object} caps Capabilities.
     * @param {number} gen Generation of this render.
     * @returns {Promise<HTMLElement|null>} Box.
     */
    async function seasonActions(status, caps, gen) {
        const m = /^(.*):s(\d+)$/.exec(String(status.key || ''));
        const summary = status.summary || {};
        if (!m || !(summary.aired > 0) || summary.ready > 0 || summary.downloading > 0 || summary.almostReady > 0
            || !['notHere', 'looking'].includes(status.stage) || status.attention || !seasonOfferable(summary)) return null;
        const key = JE.arrAsk.seriesKey(m[1]);
        const season = Number(m[2]);
        const contact = JE.arrAsk.contact(caps);
        const box = actionsBox(caps);
        // Seerr with partial requests off takes the whole series only: the button says so.
        const whole = !!JE.arrAsk.wholeSeriesOnly?.(caps);
        const doneKey = whole ? `${key}|series` : `${key}|season:${season}`;
        const label = whole ? JE.arrAsk.roundedLabel(caps, [season], caps.asksFirst)
            : caps.asksFirst ? tr('arr_actions_ask_season', { contact, season }) : tr('arr_actions_get_season', { season });
        box.appendChild(action(doneKey, 'download', label,
            (b) => run(b, doneKey, async () => (whole ? required(JE.arrAsk.wholeSeriesInput(key)) : JE.arrAsk.seasonsInput(key, [season])), 'tv')));
        if (whole) box.appendChild(JE.arrStatus.el('span', 'je-ask-action-cost je-ask-action-note', JE.arrAsk.roundedNote(caps, [season])));
        const allowance = await quota('tv');
        if (gen !== generation) return null;
        const line = JE.internals?.arrAskSheet?.costLine?.(JE.arrAsk.seasonsInput(key, [season]), caps, allowance);
        if (line?.text) box.appendChild(JE.arrStatus.el('span', 'je-ask-action-cost', line.text));
        box.dataset.sig = signature(box);
        return box;
    }

    /**
     * The input of an ask that must name something (the whole series, its seasons read first): when they can't be
     * read the ask fails ("Couldn't ask right now") instead of reading as nothing left to get.
     * @param {Promise<Object|null>} pending The input being prepared.
     * @returns {Promise<Object>} Input.
     */
    async function required(pending) {
        const input = await pending;
        if (!input) throw new Error('the series\' seasons could not be read');
        return input;
    }

    /**
     * The input of "Get missing episodes": reads the seasons with missing episodes (their own
     * status) and names every missing aired episode nobody is fetching (not monitored, or not in the
     * arr); monitored ones are searched by the Search button or looked for right now.
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
                // Nobody fetches it (missing for a long while: the Search button; looked for now: nothing).
                if (askable(ep)) episodes.push({ season, episode: ep.episode });
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
     * @param {Object} owner The press's owner (JE.ownerOf(event)): the sheet is its surface.
     * @returns {Promise<void>}
     */
    async function openSheet(button, status, plan, owner) {
        if (!JE.arrAskSheet || !owner) return;
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
        // The sheet is the press's surface: admitted only while its owner is current (checked again by the sheet).
        if (!JE.effectOwner(owner, 'the request sheet')) return;
        const result = await JE.arrAskSheet.open({
            key: JE.arrAsk.seriesKey(status.key),
            kind: 'series',
            name: item?.Name || '',
            year: Number.isInteger(item?.ProductionYear) ? item.ProductionYear : undefined,
            poster: posterOf(item),
            seasons,
            latestSeason: latest,
            nextSeason: upcoming,
            askedSeasons: plan.askedSeasons
        }, { opener: button, operation: owner });
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
     * A movie in the library: Get 4K for people who may ask for 4K when no 4K copy is here: neither a version of
     * this item nor a copy elsewhere they can open (the status' `fourK`, from the server's edition check). Only the
     * server's answer counts: Jellyfin 10.11 also lists a version from a library the viewer can't open (or above
     * their parental limit) among the item's media sources, and that one isn't theirs.
     * @param {HTMLElement} page Page.
     * @param {Object} status Movie status.
     * @param {Object} caps Capabilities.
     * @param {number} gen Generation.
     * @returns {HTMLElement|null} Box.
     */
    function movieActions(page, status, caps, gen) {
        if (!caps.can4kMovies || !status.itemId || status.fourK === true || gen !== generation) return null;
        const box = actionsBox(caps);
        const contact = JE.arrAsk.contact(caps);
        const key = status.key;
        const doneKey = `${key}|4k`;
        box.appendChild(action(doneKey, '4k', caps.asksFirst ? tr('arr_actions_ask_4k', { contact }) : tr('arr_actions_get_4k'),
            (b) => run(b, doneKey, async () => JE.arrAsk.movieInput(key, '4k'), 'movie'), true));
        box.dataset.jeAskVariant = '4k';
        box.dataset.sig = signature(box);
        return box;
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
    JE.internals.arrAskActions = { attachDetails, clear, seriesPlan, missingInput, tmdbSeasons, runSearch };
})(window.JellyfinEnhanced);
