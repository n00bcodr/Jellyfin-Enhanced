/**
 * @file Requests & downloads, phase 3: the Managers' chip bar on the home page, "3 need your OK ·
 * 1 stuck", above the first home row. Managers and Admins only, from GET /JellyfinEnhanced/acquire/
 * requests/attention (no network on the server's side); hidden when both counts are 0 or the feature
 * is off. The chips link to the Approvals tab (#/requests?tab=approvals, and &show=stuck for the stuck
 * ones). It follows the change feed (the shared request-list key is bumped on every request change)
 * instead of polling, and reads again on each visit to the home page. The first read waits until
 * the page has been up for a moment.
 */
(function (JE) {
    'use strict';

    const H = (JE.internals = JE.internals || {}).arrHub = JE.internals.arrHub || {};
    const X = H.ext;
    const ROUTE = '/acquire/requests/attention';
    const FIRST_READ_MS = 400;
    const MOUNT_RETRIES = [300, 800, 1500, 3000];
    const logPrefix = '🪼 Jellyfin Enhanced: Chip bar:';

    const tokens = X.intent('chipbar');
    const state = {
        started: false,
        startedAt: 0,
        epoch: null,
        counts: null,
        timer: null,
        mountTimer: null,
        unfollow: null
    };

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
     * Forgets everything about another user (and takes their chips away).
     * @returns {void}
     */
    function resetForUser() {
        if (state.epoch === X.epoch()) return;
        state.epoch = X.epoch();
        state.counts = null;
        tokens.drop();
        if (state.unfollow) state.unfollow();
        state.unfollow = null;
        remove();
    }

    /**
     * Schedules a read for the home page (no read during the page's first moment).
     * @returns {void}
     */
    function check() {
        if (!state.started || !onHome()) return;
        const wait = Math.max(0, FIRST_READ_MS - (Date.now() - state.startedAt));
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
            state.timer = null;
            refresh();
        }, wait);
    }

    /**
     * Reads the counts under a fresh intent token and shows them (Managers and Admins only).
     * @returns {Promise<void>}
     */
    async function refresh() {
        resetForUser();
        if (!onHome() || !JE.arrAsk?.enabled?.()) return;
        const token = tokens.next({ page: 'home' });
        const caps = await JE.arrAsk.me();
        if (!tokens.isCurrent(token)) return;
        if (!caps || !(caps.role === 'manager' || caps.role === 'admin')) {
            state.counts = null;
            remove();
            return;
        }
        follow();
        const answer = await X.call(ROUTE);
        if (!tokens.isCurrent(token)) return;
        if (answer.status !== 200) {
            if (answer.status === 403) {
                state.counts = null;
                remove();
            } else {
                console.warn(`${logPrefix} could not read the counts (${answer.status || 'no answer'})`);
            }
            return;
        }
        state.counts = { needOk: Math.max(0, answer.body?.needOk | 0), stuck: Math.max(0, answer.body?.stuck | 0) };
        mount(0);
    }

    /**
     * Follows the shared request-list key: a change reads the counts again on the home page.
     * @returns {void}
     */
    function follow() {
        if (state.unfollow) return;
        state.unfollow = X.follow(['req:state'], () => {
            if (onHome()) refresh();
        });
    }

    /**
     * Puts the bar at the top of the home sections (waiting a little for them to be drawn), or
     * takes it away when there is nothing to say.
     * @param {number} tries Attempts so far.
     * @returns {void}
     */
    function mount(tries) {
        if (state.mountTimer) clearTimeout(state.mountTimer);
        state.mountTimer = null;
        const counts = state.counts;
        if (!counts || (counts.needOk === 0 && counts.stuck === 0)) {
            remove();
            return;
        }
        const home = container();
        if (!home) {
            if (tries < MOUNT_RETRIES.length && onHome()) state.mountTimer = setTimeout(() => mount(tries + 1), MOUNT_RETRIES[tries]);
            return;
        }
        H.injectExtraStyles?.();
        let bar = [...home.children].find(c => c.classList.contains('je-chipbar'));
        if (!bar) {
            remove();
            bar = X.el('div', 'je-chipbar');
            bar.setAttribute('role', 'group');
            bar.setAttribute('aria-label', X.tr('arr_chipbar_label'));
            home.insertBefore(bar, home.firstChild);
        }
        fill(bar, counts);
    }

    /**
     * Fills the bar's chips, keeping focus on the same chip.
     * @param {HTMLElement} bar Bar.
     * @param {{needOk: number, stuck: number}} counts Counts.
     * @returns {void}
     */
    function fill(bar, counts) {
        const focus = X.focusedId(bar);
        bar.textContent = '';
        if (counts.needOk > 0) {
            bar.appendChild(chip('je-chipbar-ok', 'how_to_reg', counts.needOk === 1 ? X.tr('arr_chipbar_need_ok_one') : X.tr('arr_chipbar_need_ok', { count: counts.needOk }), '#/requests?tab=approvals', 'chipbar:ok'));
        }
        if (counts.stuck > 0) {
            bar.appendChild(chip('je-chipbar-stuck', 'schedule', X.tr('arr_chipbar_stuck', { count: counts.stuck }), '#/requests?tab=approvals&show=stuck', 'chipbar:stuck'));
        }
        if (focus !== null) {
            const target = [...bar.querySelectorAll('[data-je-focus]')].find(n => n.dataset.jeFocus === focus) || bar.querySelector('a');
            target?.focus({ preventScroll: true });
        }
    }

    /**
     * One chip: a real link (keyboard and TV focusable) with an icon, words and a chevron.
     * @param {string} cls Class.
     * @param {string} iconName Icon.
     * @param {string} text Words.
     * @param {string} href Requests page link.
     * @param {string} focusId Focus id.
     * @returns {HTMLAnchorElement} Chip.
     */
    function chip(cls, iconName, text, href, focusId) {
        const a = X.el('a', `je-chipbar-chip ${cls}`);
        a.href = href;
        a.dataset.jeFocus = focusId;
        a.appendChild(X.icon(iconName));
        a.appendChild(X.el('span', 'je-chipbar-text', text));
        a.appendChild(X.icon('chevron_right', 'je-chipbar-chevron'));
        a.addEventListener('click', (e) => {
            e.preventDefault();
            if (JE.arrHub?.show) {
                history.pushState({ page: 'requests' }, '', href);
                JE.arrHub.show();
            } else {
                window.location.hash = href;
            }
        });
        return a;
    }

    /**
     * Takes the bar away.
     * @returns {void}
     */
    function remove() {
        document.querySelectorAll('.je-chipbar').forEach(n => n.remove());
    }

    /**
     * Starts the chip bar (with the Requests page, when the request controls are on).
     * @returns {void}
     */
    function start() {
        if (state.started || !JE.arrAsk?.enabled?.()) return;
        state.started = true;
        state.startedAt = Date.now();
        state.epoch = X.epoch();
        const off = JE.core?.navigation?.onNavigate?.(check);
        const lifecycle = JE.core?.lifecycle?.register?.('arr-chipbar');
        if (lifecycle && off) lifecycle.track(off);
        document.addEventListener('viewshow', () => check());
        check();
    }

    JE.session?.onUserChange?.('arr-chipbar', () => {
        resetForUser();
        check();
    });

    H.starters = H.starters || [];
    H.starters.push(start);
    H.chipbar = { refresh, state, onHome };
})(window.JellyfinEnhanced);
