/**
 * @file Requests & downloads, phase 3: the "Not in your library" row on Jellyfin's search page for the
 * JE request backend. While the caller types, the query (debounced 300 ms) goes to
 * GET /JellyfinEnhanced/acquire/search (TMDB movies and series through the server, filtered for the
 * caller: Kids only get titles within their parental limits) and the titles the caller doesn't have
 * are shown as a row of the shared Discover cards (Request / "Ask {contact}" / Notify me) after
 * Jellyfin's own Movies and Shows rows. Only in JE mode, for people who may ask, and never while
 * Seerr's own search row is on; Kids don't get it when the server hides search from them
 * (ArrKidsHideSearch). Every search carries an intent token (query, page, user epoch, sequence): a
 * newer keystroke aborts the older read and only the current one may draw (or clear) the row.
 * Starts itself on the first navigation once the request controls are on; JE.initializeArrAskSearch
 * starts it directly (idempotent).
 */
(function (JE) {
    'use strict';

    const DEBOUNCE_MS = 300;
    const MAX_QUERY = 100;
    const SECTION_CLASS = 'je-ask-search-section';
    const logPrefix = '🪼 Jellyfin Enhanced: Search:';

    const state = {
        started: false,
        timer: null,
        controller: null,
        token: null,
        seq: 0,
        query: null,
        section: null
    };

    /**
     * Translates through the shared status helper.
     * @param {string} key en.json key.
     * @param {Object} [params] Parameters.
     * @returns {string} Text.
     */
    function tr(key, params) {
        return JE.arrStatus ? JE.arrStatus.tr(key, params) : key;
    }

    /**
     * Creates an element.
     * @param {string} tag Tag.
     * @param {string} [cls] Classes.
     * @param {string} [text] Text.
     * @returns {HTMLElement} Element.
     */
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    /**
     * The current session epoch (a user switch changes it).
     * @returns {number} Epoch.
     */
    function epoch() {
        return JE.session?.getEpoch ? JE.session.getEpoch() : 0;
    }

    /**
     * The visible search box, if the search page is shown.
     * @returns {HTMLInputElement|null} Input.
     */
    function searchInput() {
        return document.querySelector('#searchPage:not(.hide) #searchTextInput');
    }

    /**
     * The query a search box holds (trimmed, at most 100 characters).
     * @param {HTMLInputElement|null} input Input.
     * @returns {string} Query.
     */
    function queryOf(input) {
        return String(input?.value || '').trim().slice(0, MAX_QUERY);
    }

    /**
     * True when Seerr's own search row is on (it then stays the only one).
     * @returns {boolean} Seerr row on.
     */
    function seerrRowOn() {
        return (JE.pluginConfig?.JellyseerrEnabled === true && JE.pluginConfig?.JellyseerrShowSearchResults !== false)
            || !!document.querySelector('#searchPage .jellyseerr-section');
    }

    /**
     * True when this caller gets the row: JE mode, may ask, not a Kid with search hidden, and no
     * Seerr row.
     * @param {Object|null} caps Capabilities (JE.arrAsk.me).
     * @returns {boolean} Allowed.
     */
    function allowed(caps) {
        if (!caps || !caps.canRequest || caps.backend !== 'je') return false;
        if (caps.role === 'kid' && JE.pluginConfig?.ArrKidsHideSearch === true) return false;
        return !seerrRowOn();
    }

    /**
     * A new intent token for a search: the tab, row, query, filter, page, user epoch and a sequence.
     * @param {string} query Query.
     * @param {number} page Page.
     * @returns {Object} Token.
     */
    function intent(query, page) {
        state.seq += 1;
        return Object.freeze({ tab: 'search', row: 'search', query, filter: 'all', page, epoch: epoch(), seq: state.seq });
    }

    /**
     * True while a token is still the current search: not replaced, same user, and the box still
     * holds its query.
     * @param {Object} token Token.
     * @returns {boolean} Current.
     */
    function current(token) {
        return state.token === token && token.epoch === epoch() && queryOf(searchInput()) === token.query;
    }

    /**
     * Stops the search on its way and removes the row.
     * @returns {void}
     */
    function clear() {
        clearTimeout(state.timer);
        state.timer = null;
        state.controller?.abort();
        state.controller = null;
        state.token = null;
        state.query = null;
        state.section = null;
        document.querySelectorAll(`.${SECTION_CLASS}`).forEach(n => n.remove());
    }

    /**
     * The search box changed: the read on its way is stale (aborted); a new one starts once the box
     * has been quiet for 300 ms.
     * @returns {void}
     */
    function onInput() {
        clearTimeout(state.timer);
        state.timer = null;
        const query = queryOf(searchInput());
        if (query === state.query && state.section && !state.token) {
            place(state.section);
            return;
        }
        state.controller?.abort();
        state.controller = null;
        state.token = null;
        if (!query) {
            clear();
            return;
        }
        state.timer = setTimeout(() => {
            state.timer = null;
            search(query);
        }, DEBOUNCE_MS);
    }

    /**
     * Searches for a query and draws (or removes) the row when the answer is still current.
     * @param {string} query Query.
     * @returns {Promise<void>}
     */
    async function search(query) {
        const token = intent(query, 1);
        state.token = token;
        const caps = await JE.arrAsk.me();
        if (!current(token)) return;
        if (!allowed(caps)) {
            clear();
            return;
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        state.controller = controller;
        const lang = (navigator.language || 'en').split('-')[0].toLowerCase();
        let answer = null;
        try {
            answer = await JE.arrAsk.call(`/acquire/search?q=${encodeURIComponent(query)}&page=1&language=${encodeURIComponent(lang)}`, { signal: controller?.signal });
        } catch (err) {
            if (!current(token)) return;
            console.warn(`${logPrefix} search failed (${err?.message || err})`);
        }
        if (!current(token)) return;
        state.controller = null;
        state.token = null;
        if (answer?.status === 403) {
            clear();
            return;
        }
        const results = answer?.status === 200 && Array.isArray(answer.body?.answer?.results)
            ? answer.body.answer.results.filter(c => c && !c.inLibrary) : null;
        draw(query, results, caps);
    }

    /**
     * Draws the row for a query: the cards, a note when the search failed, nothing when there is
     * nothing the caller doesn't have.
     * @param {string} query Query.
     * @param {Object[]|null} results Cards (null: the search failed).
     * @param {Object} caps Capabilities.
     * @returns {void}
     */
    function draw(query, results, caps) {
        document.querySelectorAll(`.${SECTION_CLASS}`).forEach(n => n.remove());
        state.section = null;
        state.query = query;
        if (results && !results.length) return;
        const D = JE.internals?.arrDiscover;
        if (!D?.buildCard) return;
        D.injectStyles?.();
        const section = el('div', `verticalSection ${SECTION_CLASS}`);
        section.dataset.jeAskSearch = 'true';
        section.appendChild(el('h2', 'sectionTitle sectionTitle-cards padded-left padded-right', tr('arr_search_row_title')));
        if (!results) {
            section.appendChild(el('div', 'je-discover-note padded-left padded-right', tr('arr_search_error')));
        } else {
            const strip = el('div', 'je-discover-strip padded-left padded-right');
            const ctx = { caps, surface: 'search' };
            for (const card of results) strip.appendChild(D.buildCard(card, ctx));
            section.appendChild(strip);
        }
        state.section = section;
        place(section);
    }

    /**
     * Puts the row after Jellyfin's last Movies / Shows row (by card type, not by the localised
     * title), else at the end of the results; leaves it where it is when it is already there, so
     * the page's own observers aren't woken for nothing. Jellyfin's own nodes are never changed.
     * @param {HTMLElement} section Row.
     * @returns {void}
     */
    function place(section) {
        const page = document.querySelector('#searchPage:not(.hide)');
        if (!page) return;
        const sections = [...page.querySelectorAll(`.verticalSection:not(.${SECTION_CLASS}):not(.jellyseerr-section)`)];
        const primary = sections.filter(s => ['movie', 'series'].includes(s.querySelector('[data-type]')?.dataset.type?.toLowerCase())).pop();
        if (primary) {
            if (primary.nextElementSibling !== section) primary.after(section);
            return;
        }
        const container = page.querySelector('.searchResults, [class*="searchResults"], .padded-top.padded-bottom-page') || page;
        if (section.parentElement !== container || container.lastElementChild !== section) container.appendChild(section);
    }

    /**
     * Follows the search box (once per box: jellyfin-web may build a new one) and keeps the row on
     * the page when the page re-renders around it.
     * @returns {void}
     */
    function check() {
        const input = searchInput();
        if (!input) {
            if (state.query !== null || state.token || state.timer) clear();
            return;
        }
        if (!input.dataset.jeAskSearch) {
            input.dataset.jeAskSearch = 'true';
            input.addEventListener('input', onInput);
            if (queryOf(input)) onInput();
            return;
        }
        if (state.section && !state.section.isConnected && queryOf(input) === state.query) place(state.section);
    }

    /**
     * After a navigation: away from the search page the row goes; on it, the box is followed and a
     * query typed meanwhile is searched.
     * @returns {void}
     */
    function afterNavigate() {
        setTimeout(() => {
            check();
            const input = searchInput();
            if (input && queryOf(input) !== state.query && !state.timer && !state.token) onInput();
        }, 200);
    }

    /**
     * Starts the row (once) when the request controls are on.
     * @returns {void}
     */
    function initialize() {
        if (state.started || !JE.arrAsk?.enabled?.()) return;
        state.started = true;
        JE.helpers?.onBodyMutation?.('je-ask-search', check);
        JE.core?.navigation?.onNavigate?.(afterNavigate);
        check();
    }

    JE.session?.onUserChange?.('arr-ask-search', clear);
    // Starts on the first navigation after the plugin configuration has loaded (the request
    // controls' switch is in it); nothing runs before that.
    JE.core?.navigation?.onNavigate?.(() => {
        if (!state.started) initialize();
    });

    JE.internals = JE.internals || {};
    JE.internals.arrAskSearch = { state, search, check, clear, allowed };
    JE.initializeArrAskSearch = initialize;
})(window.JellyfinEnhanced);
