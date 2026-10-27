/**
 * @file Requests & downloads, phase 3: the "Not in your library" row on Jellyfin's search page for the
 * JE request backend. While the caller types, the query (debounced 300 ms) goes to
 * GET /JellyfinEnhanced/acquire/search (TMDB movies and series through the server, filtered for the
 * caller: Kids only get titles within their parental limits) and the titles the caller doesn't have
 * are shown as a row of the shared Discover cards (Request / "Ask {contact}" / Notify me) after
 * Jellyfin's own Movies and Shows rows. Only in JE mode and for people who may ask. In JE mode this row
 * replaces Seerr's search row (Seerr no longer takes requests, so JE.internals.arrAskSearch.replacesSeerr()
 * tells the Seerr search not to draw one); Kids don't get it when the server hides search from them
 * (ArrKidsHideSearch). Every search carries an intent token (query, page, user epoch, sequence): a
 * newer keystroke aborts the older read and only the current one may draw (or clear) the row.
 * While the row is up and Jellyfin found nothing itself, Jellyfin's "no results" message is hidden and the
 * row says the library has no matches instead (the page never claims there are no results above titles).
 * A failed search shows Try again: it searches the same query again (bounded by SEARCH_TIMEOUT_MS), keeps
 * focus in the row and draws one row.
 * Starts itself on the first navigation once the request controls are on; JE.initializeArrAskSearch
 * starts it directly (idempotent).
 */
(function (JE) {
    'use strict';

    const DEBOUNCE_MS = 300;
    const MAX_QUERY = 100;
    const SECTION_CLASS = 'je-ask-search-section';
    const NATIVE_HIDDEN_CLASS = 'je-ask-search-native-hidden';
    const LOCAL_NONE_CLASS = 'je-ask-search-local-none';
    const RETRY_CLASS = 'je-ask-search-retry';
    // A search (first or Try again) that gets no answer in this time fails: Try again never spins forever.
    const SEARCH_TIMEOUT_MS = 15000;
    const CSS = `
.${NATIVE_HIDDEN_CLASS} { display: none !important; }
.${LOCAL_NONE_CLASS} { margin: 1em 0 0.4em; opacity: 0.8; }
.je-ask-search-error { display: flex; align-items: center; gap: 0.8em; flex-wrap: wrap; }
.je-ask-search-error .je-discover-note { flex: 1 1 16em; }
.je-ask-search-error .je-discover-btn { width: auto; }
.${SECTION_CLASS} .sectionTitle:focus { outline: none; }
.${SECTION_CLASS} .sectionTitle:focus-visible { outline: 3px solid #a78bfa; outline-offset: 2px; }`;
    const logPrefix = '🪼 Jellyfin Enhanced: Search:';

    const state = {
        started: false,
        timer: null,
        controller: null,
        token: null,
        seq: 0,
        query: null,
        section: null,
        hiddenNative: null
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
     * Adds the row's own styles once (the cards' come from the Discover tab).
     * @returns {void}
     */
    function injectStyles() {
        if (document.getElementById('je-ask-search-styles')) return;
        const style = document.createElement('style');
        style.id = 'je-ask-search-styles';
        style.textContent = CSS;
        document.head.appendChild(style);
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
     * True in JE mode: this row replaces Seerr's search row (the Seerr search draws none, whoever is signed in).
     * @returns {boolean} Replaces the Seerr row.
     */
    function replacesSeerr() {
        return JE.pluginConfig?.ArrRequestsJeMode === true && JE.arrAsk?.enabled?.() === true;
    }

    /**
     * True when this caller gets the row: JE mode, may ask, and not a Kid with search hidden. Seerr's row
     * doesn't stop it in JE mode (it isn't drawn then); a Seerr row that is somehow on the page still does.
     * @param {Object|null} caps Capabilities (JE.arrAsk.me).
     * @returns {boolean} Allowed.
     */
    function allowed(caps) {
        if (!caps || !caps.canRequest || caps.backend !== 'je') return false;
        if (caps.role === 'kid' && JE.pluginConfig?.ArrKidsHideSearch === true) return false;
        return replacesSeerr() ? !document.querySelector('#searchPage .jellyseerr-section') : !seerrRowOn();
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
        syncNative();
    }

    /**
     * Jellyfin's own "no results" message on the search page, when it is shown (other scripts may keep a
     * hidden one there; one this row hid still counts).
     * @param {HTMLElement} page Search page.
     * @returns {HTMLElement|null} Message.
     */
    function nativeEmptyMessage(page) {
        return [...page.querySelectorAll('.noItemsMessage')].find(n => !n.closest(`.${SECTION_CLASS}`) && n.style.display !== 'none'
            && (n.classList.contains(NATIVE_HIDDEN_CLASS) || getComputedStyle(n).display !== 'none')) || null;
    }

    /**
     * While the row is on the search page and Jellyfin found nothing: hides Jellyfin's "no results" message
     * (a class, never its text: the node is React's) and shows the row's own "nothing in your library" line;
     * otherwise puts both back. Writes only on change (the page's observers call this).
     * @returns {void}
     */
    function syncNative() {
        if (!state.section && !state.hiddenNative) return;
        const page = document.querySelector('#searchPage:not(.hide)');
        const section = state.section?.isConnected && page?.contains(state.section) ? state.section : null;
        const message = section ? nativeEmptyMessage(page) : null;
        if (state.hiddenNative && state.hiddenNative !== message) state.hiddenNative.classList.remove(NATIVE_HIDDEN_CLASS);
        state.hiddenNative = message;
        if (message && !message.classList.contains(NATIVE_HIDDEN_CLASS)) message.classList.add(NATIVE_HIDDEN_CLASS);
        const line = section?.querySelector(`.${LOCAL_NONE_CLASS}`);
        if (line && line.hidden !== !message) line.hidden = !message;
    }

    /**
     * Puts a Try again pressed while its search was on its way back to rest (the search was replaced).
     * @returns {void}
     */
    function settleRetry() {
        const button = state.section?.querySelector(`.${RETRY_CLASS}`);
        if (!button || button.getAttribute('aria-busy') !== 'true') return;
        button.removeAttribute('aria-busy');
        button.textContent = tr('arr_discover_retry');
    }

    /**
     * Try again on a failed search: the same query again, at once. Ignored while a search is on its way or
     * when the box no longer holds the failed query (typing searches by itself).
     * @param {HTMLButtonElement} button The button.
     * @returns {void}
     */
    function retry(button) {
        if (state.token || state.timer || button.getAttribute('aria-busy') === 'true') return;
        const query = queryOf(searchInput());
        if (!query || query !== state.query) {
            onInput();
            return;
        }
        button.setAttribute('aria-busy', 'true');
        button.textContent = tr('arr_search_retrying');
        search(query);
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
        settleRetry();
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
            answer = await JE.arrAsk.call(`/acquire/search?q=${encodeURIComponent(query)}&page=1&language=${encodeURIComponent(lang)}`, { signal: controller?.signal, timeoutMs: SEARCH_TIMEOUT_MS });
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
     * Draws the row for a query: the cards, a note with Try again when the search failed, nothing when
     * there is nothing the caller doesn't have. Focus in the row it replaces moves to the new row (its Try
     * again, else its heading), never to the page.
     * @param {string} query Query.
     * @param {Object[]|null} results Cards (null: the search failed).
     * @param {Object} caps Capabilities.
     * @returns {void}
     */
    function draw(query, results, caps) {
        const old = [...document.querySelectorAll(`.${SECTION_CLASS}`)];
        const hadFocus = old.some(n => n.contains(document.activeElement));
        old.forEach(n => n.remove());
        state.section = null;
        state.query = query;
        if (results && !results.length) {
            syncNative();
            return;
        }
        const D = JE.internals?.arrDiscover;
        if (!D?.buildCard) {
            syncNative();
            return;
        }
        D.injectStyles?.();
        injectStyles();
        const section = el('div', `verticalSection ${SECTION_CLASS}`);
        section.dataset.jeAskSearch = 'true';
        const none = el('p', `${LOCAL_NONE_CLASS} padded-left padded-right`, tr('arr_search_local_none', { query }));
        none.hidden = true;
        section.appendChild(none);
        const heading = el('h2', 'sectionTitle sectionTitle-cards padded-left padded-right', tr('arr_search_row_title'));
        heading.tabIndex = -1;
        section.appendChild(heading);
        if (!results) {
            const error = el('div', 'je-ask-search-error padded-left padded-right');
            error.setAttribute('role', 'alert');
            error.appendChild(el('div', 'je-discover-note', tr('arr_search_error')));
            const again = /** @type {HTMLButtonElement} */ (el('button', `je-discover-btn je-discover-retry ${RETRY_CLASS}`, tr('arr_discover_retry')));
            again.type = 'button';
            again.setAttribute('aria-label', tr('arr_search_retry_label', { query }));
            again.addEventListener('click', () => retry(again));
            error.appendChild(again);
            section.appendChild(error);
        } else {
            const strip = el('div', 'je-discover-strip padded-left padded-right');
            const ctx = { caps, surface: 'search' };
            for (const card of results) strip.appendChild(D.buildCard(card, ctx));
            section.appendChild(strip);
        }
        state.section = section;
        place(section);
        if (hadFocus && section.isConnected) (section.querySelector(`.${RETRY_CLASS}`) || heading).focus({ preventScroll: true });
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
        } else {
            const container = page.querySelector('.searchResults, [class*="searchResults"], .padded-top.padded-bottom-page') || page;
            if (section.parentElement !== container || container.lastElementChild !== section) container.appendChild(section);
        }
        syncNative();
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
        else syncNative();
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
    JE.internals.arrAskSearch = { state, search, check, clear, allowed, replacesSeerr, retry, SEARCH_TIMEOUT_MS };
    JE.initializeArrAskSearch = initialize;
})(window.JellyfinEnhanced);
