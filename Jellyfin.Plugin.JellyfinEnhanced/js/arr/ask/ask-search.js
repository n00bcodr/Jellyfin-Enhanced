/**
 * @file Requests & downloads, phase 3: the "Not in your library" row on Jellyfin's search page for the
 * JE request backend. While the caller types, the query (debounced 300 ms) goes to
 * GET /JellyfinEnhanced/acquire/search (TMDB movies and series through the server, filtered for the
 * caller: Kids only get titles within their parental limits) and the titles the caller doesn't have
 * are shown as a row of the shared Discover cards (Request / "Ask {contact}" / Notify me) after
 * all of Jellyfin's own rows. Only in JE mode and for people who may ask. In JE mode this row
 * replaces Seerr's search row (Seerr no longer takes requests, so JE.internals.arrAskSearch.replacesSeerr()
 * tells the Seerr search not to draw one); Kids don't get it when the server hides search from them
 * (ArrKidsHideSearch). Every search carries an intent token (query, page, user epoch, sequence): a
 * newer keystroke aborts the older read and only the current one may draw (or clear) the row.
 * While the row is up and Jellyfin found nothing itself, Jellyfin's "no results" message is hidden and the
 * row says the library has no matches instead (the page never claims there are no results above titles).
 * A failed search shows Try again: it searches the same query again, keeps focus in the row and draws one
 * row. Every search (capabilities read included) has one SEARCH_TIMEOUT_MS deadline. Jellyfin's message is
 * synchronised before paint (a priority body-observer subscriber), so it never shows above the row.
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
    // A search (first or Try again) that gets no answer in this time, its capabilities read included, fails:
    // Try again never spins forever.
    const SEARCH_TIMEOUT_MS = 15000;
    // Hidden without touching display, so its owner's own hiding (display: none) can still be read.
    const CSS = `
.${NATIVE_HIDDEN_CLASS} { visibility: hidden !important; position: absolute !important; width: 1px !important; height: 1px !important;
  margin: 0 !important; padding: 0 !important; overflow: hidden !important; clip-path: inset(50%) !important; pointer-events: none !important; }
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
     * Jellyfin's own "no results" message on the search page, while its owner shows it: never when the page
     * has local results, nor when its owner (Jellyfin or another script) hides it. This row's own hiding keeps
     * display alone, so the owner's state is read through it.
     * @param {HTMLElement} page Search page.
     * @returns {HTMLElement|null} Message.
     */
    function nativeEmptyMessage(page) {
        const local = [...page.querySelectorAll(`.verticalSection:not(.${SECTION_CLASS}):not(.jellyseerr-section)`)].some(s => s.querySelector('.card'));
        if (local) return null;
        return [...page.querySelectorAll('.noItemsMessage')].find(n => !n.closest(`.${SECTION_CLASS}`) && !n.hidden && n.style.display !== 'none'
            && getComputedStyle(n).display !== 'none') || null;
    }

    /**
     * While the row is on the search page and Jellyfin found nothing: hides Jellyfin's "no results" message
     * (a class, never its text: the node is React's) and shows the row's own "nothing in your library" line,
     * only while the box still holds the row's query (a new query hides it until its row is drawn);
     * otherwise puts both back. Writes only on change (the page's observers call this, before paint).
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
        const hide = !message || queryOf(searchInput()) !== state.query;
        if (line && line.hidden !== hide) line.hidden = hide;
    }

    /**
     * Waits for a promise while a signal is live; rejects with the signal's reason (or an AbortError) once it
     * aborts. The promise itself is left to finish (a shared read other callers may use).
     * @param {Promise<*>} promise Promise.
     * @param {AbortSignal} signal Signal.
     * @returns {Promise<*>} Its value.
     */
    function whileLive(promise, signal) {
        return new Promise((resolve, reject) => {
            const stop = () => reject(signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (signal.aborted) {
                stop();
                return;
            }
            signal.addEventListener('abort', stop, { once: true });
            Promise.resolve(promise).then(value => { signal.removeEventListener('abort', stop); resolve(value); },
                err => { signal.removeEventListener('abort', stop); reject(err); });
        });
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
        syncNative();
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
        // One deadline for the whole search, from the keystroke's or Try again's moment: the capabilities read,
        // the wait in the client's request queue (an aborted queued request leaves the queue and is never sent)
        // and the search itself. A newer keystroke aborts the same controller.
        const deadline = Date.now() + SEARCH_TIMEOUT_MS;
        const controller = new AbortController();
        state.controller = controller;
        const timer = setTimeout(() => controller.abort(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), SEARCH_TIMEOUT_MS);
        let answer = null;
        let caps;
        try {
            try {
                caps = await whileLive(JE.arrAsk.me(), controller.signal);
            } catch (err) {
                if (!current(token)) return;
                console.warn(`${logPrefix} capabilities not read in time (${err?.message || err})`);
                state.controller = null;
                state.token = null;
                // A row on the page (a Try again) says the search failed again; with none, nothing is drawn.
                if (state.section) draw(query, null, null);
                return;
            }
            if (!current(token)) return;
            if (!allowed(caps)) {
                clear();
                return;
            }
            const lang = (navigator.language || 'en').split('-')[0].toLowerCase();
            try {
                answer = await JE.arrAsk.call(`/acquire/search?q=${encodeURIComponent(query)}&page=1&language=${encodeURIComponent(lang)}`, { signal: controller.signal, timeoutMs: Math.max(1, deadline - Date.now()) });
            } catch (err) {
                if (!current(token)) return;
                console.warn(`${logPrefix} search failed (${err?.message || err})`);
            }
        } finally {
            clearTimeout(timer);
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
     * again, else its heading), or to the search box when there is no row now; never to the page.
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
        const D = JE.internals?.arrDiscover;
        if ((results && !results.length) || !D?.buildCard) {
            syncNative();
            if (hadFocus) searchInput()?.focus({ preventScroll: true });
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
     * Puts the row after Jellyfin's last row of results, whatever its kind (Movies, Shows, Episodes, People,
     * ...), else at the end of the results; never above one of Jellyfin's rows. Leaves it where it is when
     * it already follows them, so the page's own observers aren't woken for nothing. Jellyfin's own nodes
     * are never changed.
     * @param {HTMLElement} section Row.
     * @returns {void}
     */
    function place(section) {
        const page = document.querySelector('#searchPage:not(.hide)');
        if (!page) return;
        const last = [...page.querySelectorAll(`.verticalSection:not(.${SECTION_CLASS}):not(.jellyseerr-section)`)].pop();
        if (last) {
            if (!section.isConnected || !(last.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING)) last.after(section);
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
     * Keeps a drawn row for the box's query after Jellyfin's own rows (moved only when out of place) and
     * Jellyfin's message in step with it.
     * @returns {void}
     */
    function follow() {
        if (!state.section && !state.hiddenNative) return;
        if (state.section?.isConnected && queryOf(searchInput()) === state.query) place(state.section);
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
        // Before paint (priority: run in the observer's own microtask): Jellyfin's late "no results" message is
        // hidden and the row's line follows; rows Jellyfin adds later (a query that now has local results) get
        // the row placed after them again. A no-op while no row is up.
        JE.helpers?.onBodyMutation?.('je-ask-search-native', follow, { priority: 1 });
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
