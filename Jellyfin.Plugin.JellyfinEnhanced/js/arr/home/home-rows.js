/**
 * @file Requests & downloads, phase 4d: the home rows "Your requests", "Coming soon for you" and "Just
 * arrived for you" on Jellyfin's home page (when the server has them on: JE.pluginConfig.ArrHomeRowsEnabled).
 * Reads GET /JellyfinEnhanced/acquire/home once per home view (If-None-Match: an unchanged answer is a 304),
 * and, when the answer says so (administrators), GET /JellyfinEnhanced/arr/admin/home/ops for the ops strip.
 * Rows that are switched off (null) or empty are not drawn. Placement: after the first home section (My
 * Media) when there is one, else first (after the Managers' chip bar). On a home drawn by Home Screen
 * Sections with the rows registered there (answer hss: true) nothing is injected; HSS's JE sections are
 * decorated instead (home-hss.js). Follows the change feed for the titles shown and the person's own
 * request, follow and notification keys (administrators also admin:ops), re-reading the one route after a
 * burst of changes. Answers that arrive after the person left home or another user signed in are dropped;
 * leaving home or a user switch takes the rows away. Nothing is requested while the page loads: the first
 * read waits until the module has been up for a moment.
 * Exposes JE.arrHome { refresh(options), state }.
 */
(function (JE) {
    'use strict';

    const R = (JE.internals = JE.internals || {}).arrHome = JE.internals.arrHome || {};
    const HOME_ROUTE = '/acquire/home';
    const OPS_ROUTE = '/arr/admin/home/ops';
    const FIRST_READ_MS = 400;
    const LIVE_DEBOUNCE_MS = 300;
    const MOUNT_RETRIES = [300, 800, 1500, 3000];
    const logPrefix = '🪼 Jellyfin Enhanced: Home rows:';

    const state = {
        started: false,
        startedAt: 0,
        epoch: null,
        data: null,
        etag: null,
        ops: null,
        controller: null,
        timer: null,
        mountTimer: null,
        liveTimer: null,
        unfollow: null,
        followKeys: '',
        wrap: null,
        mode: null,
        token: null,
        seq: 0
    };

    /**
     * True when the server has the home rows on.
     * @returns {boolean} On.
     */
    function enabled() {
        return JE.pluginConfig?.ArrHomeRowsEnabled === true;
    }

    /**
     * True on Jellyfin's home page.
     * @param {string} [hash] Hash to test (default: the current one).
     * @returns {boolean} Home.
     */
    function onHome(hash) {
        const h = hash ?? window.location.hash ?? '';
        return h === '' || h === '#' || h === '#/' || /^#!?\/home(\.html)?(\?|$)/.test(h);
    }

    /**
     * The home page's sections container that is shown, if it is there yet.
     * @returns {HTMLElement|null} Container.
     */
    function container() {
        return [...document.querySelectorAll('.homeSectionsContainer')].find(c => !c.closest('.hide')) || null;
    }

    /**
     * The current session epoch (a user switch changes it).
     * @returns {number} Epoch.
     */
    function epoch() {
        return JE.session?.getEpoch ? JE.session.getEpoch() : 0;
    }

    /**
     * A new read token (only an answer read under the current token, by the same user, is used).
     * @returns {{epoch: number, seq: number}} Token.
     */
    function nextToken() {
        state.token = Object.freeze({ epoch: epoch(), seq: ++state.seq });
        return state.token;
    }

    /**
     * True when the token is still the current one.
     * @param {Object} token Token.
     * @returns {boolean} Current.
     */
    function isCurrent(token) {
        return !!token && token === state.token && token.epoch === epoch();
    }

    /**
     * The signed-in person's id (32 hex, lower case), or null.
     * @returns {string|null} Id.
     */
    function userId() {
        if (typeof JE.session?.getUserId === 'function' && !JE.session.getUserId()) return null;
        const id = typeof ApiClient !== 'undefined' && typeof ApiClient.getCurrentUserId === 'function' ? ApiClient.getCurrentUserId() : null;
        return id ? String(id).replace(/-/g, '').toLowerCase() : null;
    }

    /**
     * GETs a plugin route. Every HTTP answer resolves ({status, body, etag}); status 0 when none came back.
     * @param {string} path Path under /JellyfinEnhanced.
     * @param {AbortSignal} signal Abort signal.
     * @param {string|null} [etag] Entity tag of the answer already shown (If-None-Match).
     * @returns {Promise<{status: number, body: Object|null, etag: string|null}>} Answer.
     */
    async function get(path, signal, etag) {
        try {
            const headers = { 'Authorization': `MediaBrowser Token="${ApiClient.accessToken()}"`, 'Accept': 'application/json' };
            if (etag) headers['If-None-Match'] = etag;
            const observation = JE.core?.revision?.begin?.();
            const response = await fetch(ApiClient.getUrl(`/JellyfinEnhanced${path}`), { headers, signal, cache: 'no-store' });
            // The answer carries the person's revisions (core/access-revision.js).
            JE.core?.revision?.noteResponse(response, observation);
            if (response.status === 304) return { status: 304, body: null, etag: etag || null };
            let body = null;
            try {
                const text = await response.text();
                body = text ? JSON.parse(text) : null;
            } catch {
                body = null;
            }
            return { status: response.status, body, etag: response.headers?.get?.('ETag') || null };
        } catch {
            return { status: 0, body: null, etag: null };
        }
    }

    /**
     * Keeps only the fields the rows use, in the shapes they expect.
     * @param {Object} body Answer.
     * @returns {{requests: Object[]|null, soon: Object[]|null, arrived: Object[]|null, hss: boolean, ops: boolean}} Data.
     */
    function sanitize(body) {
        const list = v => (Array.isArray(v) ? v.filter(c => c && typeof c === 'object') : null);
        return { requests: list(body?.requests), soon: list(body?.soon), arrived: list(body?.arrived), hss: body?.hss === true, ops: body?.ops === true };
    }

    /**
     * What the person hid everywhere (Hidden Content), when it filters requests (as the Requests page does).
     * @returns {{ids: Set<string>, movies: Set<string>, shows: Set<string>}|null} Sets.
     */
    function hiddenSets() {
        const hc = JE.hiddenContent;
        if (!hc || typeof hc.getSettings !== 'function' || typeof hc.getAllHiddenItems !== 'function') return null;
        const settings = hc.getSettings() || {};
        if (!settings.enabled || !settings.filterRequests) return null;
        const sets = { ids: new Set(), movies: new Set(), shows: new Set() };
        for (const item of hc.getAllHiddenItems() || []) {
            if ((item.hideScope || 'global') !== 'global') continue;
            if (item.itemId) sets.ids.add(String(item.itemId).replace(/-/g, '').toLowerCase());
            if (!item.tmdbId) continue;
            if (item.type === 'Movie') sets.movies.add(String(item.tmdbId));
            else if (item.type === 'Series') sets.shows.add(String(item.tmdbId));
        }
        return sets.ids.size || sets.movies.size || sets.shows.size ? sets : null;
    }

    /**
     * The rows as they are shown: without titles the person hid, and Coming soon without days that passed.
     * @param {Object} data Data.
     * @returns {Object} Rows to show.
     */
    function visible(data) {
        const hidden = hiddenSets();
        const shown = (c) => {
            if (!hidden) return true;
            if (c.itemId && hidden.ids.has(R.normalizeId(c.itemId))) return false;
            const tmdb = c.tmdbId ? String(c.tmdbId) : '';
            return !(tmdb && (c.kind === 'tv' ? hidden.shows : hidden.movies).has(tmdb));
        };
        const row = (cards, extra) => (Array.isArray(cards) ? cards.filter(c => shown(c) && (!extra || extra(c))) : null);
        return {
            ...data,
            requests: row(data.requests),
            soon: row(data.soon, c => !(c.day && JE.arrStatus?.dayPassed?.(c.day))),
            arrived: row(data.arrived)
        };
    }

    /**
     * Forgets everything about another user (and takes their rows away).
     * @returns {void}
     */
    function resetForUser() {
        if (state.epoch === epoch()) return;
        state.epoch = epoch();
        state.data = null;
        state.etag = null;
        state.ops = null;
        unmount();
    }

    /**
     * Called on every navigation and view: draws what is known at once on home and schedules a read (none
     * during the module's first moment); away from home it takes the rows away.
     * @returns {void}
     */
    function check() {
        if (!state.started) return;
        resetForUser();
        if (!onHome() || !userId()) {
            unmount();
            return;
        }
        if (state.data) draw(0);
        const wait = Math.max(0, FIRST_READ_MS - (Date.now() - state.startedAt));
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
            state.timer = null;
            refresh();
        }, wait);
    }

    /**
     * Reads the rows (and the ops strip) under a fresh token and draws them.
     * @param {{fresh?: boolean}} [options] fresh: ask without If-None-Match (a setting just changed).
     * @returns {Promise<void>}
     */
    async function refresh(options) {
        resetForUser();
        if (!state.started || !enabled() || !onHome() || !userId()) return;
        if (options?.fresh) state.etag = null;
        const token = nextToken();
        if (state.controller) state.controller.abort();
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        state.controller = controller;
        const since = JE.arr?.live?.position?.() || null;
        const answer = await get(HOME_ROUTE, controller?.signal, state.data ? state.etag : null);
        if (!isCurrent(token) || !onHome()) return;
        if (answer.status === 200 && answer.body && typeof answer.body === 'object') {
            state.data = sanitize(answer.body);
            state.etag = answer.etag;
        } else if (answer.status === 304 && state.data) {
            // Unchanged.
        } else if (answer.status === 403 || answer.status === 404) {
            state.data = null;
            state.etag = null;
            state.ops = null;
            unmount();
            return;
        } else {
            if (!controller?.signal.aborted) console.warn(`${logPrefix} could not read the rows (${answer.status || 'no answer'})`);
            if (!state.data) return;
        }
        follow(state.data, since);
        draw(0);
        if (!state.data.ops) {
            if (state.ops) {
                state.ops = null;
                draw(0);
            }
            return;
        }
        const ops = await get(OPS_ROUTE, controller?.signal);
        if (!isCurrent(token) || !onHome()) return;
        const next = ops.status === 200 && ops.body && typeof ops.body === 'object' ? ops.body : ops.status === 0 ? state.ops : null;
        if (JSON.stringify(next) === JSON.stringify(state.ops)) return;
        state.ops = next;
        draw(0);
    }

    /**
     * Follows the change feed for what the rows show: every card's key and live key, the person's own
     * request-list, request-state and notification keys, and (administrators) admin:ops. A burst of changes
     * reads the route again (with If-None-Match).
     * @param {Object|null} data Data (null: stop following).
     * @param {{epoch: string, cursor: number}|null} [since] Feed position from before the read.
     * @returns {void}
     */
    function follow(data, since) {
        const keys = new Set();
        if (data) {
            for (const row of ['requests', 'soon', 'arrived']) {
                for (const card of data[row] || []) {
                    if (typeof card.key === 'string' && card.key) keys.add(card.key);
                    if (typeof card.liveKey === 'string' && card.liveKey) keys.add(card.liveKey);
                }
            }
            const me = userId();
            if (me) {
                keys.add(`req:u:${me}`);
                keys.add(`ntf:u:${me}`);
            }
            keys.add('req:state');
            if (data.ops) keys.add('admin:ops');
        }
        const list = [...keys].sort();
        const joined = list.join(',');
        if (joined === state.followKeys && (state.unfollow || !list.length)) return;
        if (state.unfollow) state.unfollow();
        state.unfollow = null;
        state.followKeys = joined;
        if (!list.length) return;
        const onChange = () => {
            if (state.liveTimer) return;
            state.liveTimer = setTimeout(() => {
                state.liveTimer = null;
                if (onHome()) refresh();
            }, LIVE_DEBOUNCE_MS);
        };
        const options = { since: since || null };
        if (typeof JE.arrStatus?.subscribe === 'function') state.unfollow = JE.arrStatus.subscribe(list, onChange, options);
        else if (typeof JE.arr?.onStatusChange === 'function') state.unfollow = JE.arr.onStatusChange(list, onChange, options);
    }

    /**
     * Stops following the change feed.
     * @returns {void}
     */
    function unfollow() {
        if (state.unfollow) state.unfollow();
        state.unfollow = null;
        state.followKeys = '';
        if (state.liveTimer) clearTimeout(state.liveTimer);
        state.liveTimer = null;
    }

    /**
     * True for an element of the home container that is one of its sections (Jellyfin's sectionN, or HSS's
     * data-page sections).
     * @param {Element} node Child of the container.
     * @param {boolean} hss The container was drawn by HSS.
     * @returns {boolean} Section.
     */
    function isSection(node, hss) {
        if (node === state.wrap || node.classList.contains('je-chipbar') || node.id === 'hssLoadingIndicator') return false;
        return hss ? node.hasAttribute('data-page') : /(^|\s)section\d+(\s|$)/.test(node.className);
    }

    /**
     * Puts the rows right after the first home section (My Media), else first (after the chip bar). Does
     * nothing when they are there already.
     * @param {HTMLElement} home Container.
     * @param {HTMLElement} wrap Rows.
     * @returns {void}
     */
    function place(home, wrap) {
        const hss = R.hss.drawn(home);
        const children = [...home.children];
        const anchor = children.find(n => isSection(n, hss)) || null;
        if (anchor) {
            if (anchor.style?.order) wrap.style.order = anchor.style.order;
            if (wrap.parentElement === home && wrap.previousElementSibling === anchor) return;
            home.insertBefore(wrap, anchor.nextSibling);
            return;
        }
        const chips = children.find(n => n.classList.contains('je-chipbar')) || null;
        const before = chips ? chips.nextSibling : home.firstChild;
        if (wrap.parentElement === home && (chips ? wrap.previousElementSibling === chips : home.firstElementChild === wrap)) return;
        home.insertBefore(wrap, before);
    }

    /**
     * The focus id (data-je-focus) of the control that has focus inside the rows, if any.
     * @param {HTMLElement|null} root Rows.
     * @returns {string|null} Id.
     */
    function focusedId(root) {
        const active = document.activeElement;
        if (!root || !active || !root.contains(active)) return null;
        return active.closest('[data-je-focus]')?.dataset.jeFocus || null;
    }

    /**
     * Draws the rows into the shown home container (waiting a little for it), or decorates HSS's sections
     * when HSS drew the home and has the rows. Never two copies: one block, re-filled in place.
     * @param {number} tries Attempts so far.
     * @returns {void}
     */
    function draw(tries) {
        if (state.mountTimer) clearTimeout(state.mountTimer);
        state.mountTimer = null;
        const data = state.data;
        if (!data || !onHome()) {
            removeRows();
            R.hss.clear();
            return;
        }
        const home = container();
        const retry = () => {
            if (tries < MOUNT_RETRIES.length && onHome()) state.mountTimer = setTimeout(() => draw(tries + 1), MOUNT_RETRIES[tries]);
        };
        if (!home) {
            retry();
            return;
        }
        R.injectStyles?.();
        const hssDrawn = R.hss.drawn(home);
        const hssMode = data.hss === true && hssDrawn;
        R.hss.watch(home, onContainerChange);
        // HSS registered the rows and is installed, but hasn't drawn the page yet: give it a moment
        // before drawing JE's own rows (never both).
        if (data.hss === true && !hssDrawn && JE.pluginConfig?.ArrHomeHssSections === true && tries < MOUNT_RETRIES.length) {
            removeRows();
            retry();
            return;
        }
        state.mode = hssMode ? 'hss' : 'native';
        const view = visible(data);
        if (hssMode) R.hss.decorate(home, view);
        else R.hss.clear();
        const wrap = state.wrap || document.createElement('div');
        wrap.className = 'je-home-rows';
        const focus = focusedId(wrap);
        R.fill(wrap, view, state.ops, { rows: !hssMode });
        if (!wrap.childNodes.length) {
            removeRows();
            return;
        }
        state.wrap = wrap;
        // A copy left over in another (hidden) home container goes.
        document.querySelectorAll('.je-home-rows').forEach(n => { if (n !== wrap) n.remove(); });
        place(home, wrap);
        if (focus) [...wrap.querySelectorAll('[data-je-focus]')].find(n => n.dataset.jeFocus === focus)?.focus({ preventScroll: true });
    }

    /**
     * The home container changed (Jellyfin or HSS drew sections again): switch between JE's rows and the HSS
     * decoration if that changed, else put the rows back in place and decorate HSS's cards again.
     * @returns {void}
     */
    function onContainerChange() {
        if (!state.data || !onHome()) return;
        const home = container();
        if (!home) return;
        const mode = state.data.hss === true && R.hss.drawn(home) ? 'hss' : 'native';
        if (mode !== state.mode || (state.wrap && !state.wrap.isConnected)) {
            draw(0);
            return;
        }
        if (mode === 'hss') R.hss.decorate(home, visible(state.data));
        if (state.wrap) place(home, state.wrap);
    }

    /**
     * Takes JE's own rows (and the ops strip) away; what was read is kept for the next home view.
     * @returns {void}
     */
    function removeRows() {
        if (state.wrap) state.wrap.remove();
        document.querySelectorAll('.je-home-rows').forEach(n => n.remove());
        state.wrap = null;
    }

    /**
     * Leaves the home page (or the user changed): rows away, no observer, no feed, reads in flight ignored.
     * @returns {void}
     */
    function unmount() {
        state.token = null;
        if (state.controller) state.controller.abort();
        state.controller = null;
        if (state.timer) clearTimeout(state.timer);
        if (state.mountTimer) clearTimeout(state.mountTimer);
        state.timer = null;
        state.mountTimer = null;
        state.mode = null;
        R.hss.unwatch();
        unfollow();
        removeRows();
        R.hss.clear();
    }

    /**
     * Starts the home rows (behind their flag). Nothing is read until the module has been up for a moment.
     * @returns {void}
     */
    function start() {
        if (state.started || !enabled()) return;
        state.started = true;
        state.startedAt = Date.now();
        state.epoch = epoch();
        const off = JE.core?.navigation?.onNavigate?.(check);
        const lifecycle = JE.core?.lifecycle?.register?.('arr-home');
        if (lifecycle && off) lifecycle.track(off);
        document.addEventListener('viewshow', () => check());
        // Hiding or unhiding something shows at once.
        window.addEventListener('je-hidden-content-changed', () => {
            if (state.data && onHome() && (state.wrap || state.mode === 'hss')) draw(0);
        });
        check();
    }

    JE.session?.onUserChange?.('arr-home', () => {
        resetForUser();
        check();
    });

    JE.arrHome = Object.freeze({
        /**
         * Reads the rows again now (on the home page only), e.g. after the person changed a row preference.
         * @param {{fresh?: boolean}} [options] fresh: ask without If-None-Match.
         * @returns {Promise<void>}
         */
        refresh: (options) => refresh(options),
        state
    });

    start();
})(window.JellyfinEnhanced);
