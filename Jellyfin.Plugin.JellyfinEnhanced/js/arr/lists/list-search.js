/**
 * @file Requests & downloads, phase 4c3b: the title search of list authoring. A presenter: it draws into a root its
 * caller owns, every write through the paint gate with the caller's ticket, and reads only through the reader it is
 * given (b2 wires the household's existing route: acquire/search or the Seerr proxy, lp.metadata.searchPath). Nothing
 * runs on load; nothing is cached.
 *
 * Every query starts a new intent: the older read is aborted and its answer, if it still comes, is dropped, so only the
 * newest query is drawn. A person search refuses gets custom entries only, with the reason. An administrator's arr
 * lookup (when the core supplies one) is its own group; an arr result without a TMDB id is labelled custom-only and
 * gives an inert candidate.
 *
 * Internal: lp.search { KEYS, create }.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.arrListPages = JE.internals.arrListPages || {};

    const KEYS = Object.freeze([
        'arr_lists_search_label', 'arr_lists_search_empty', 'arr_lists_search_failed', 'arr_lists_search_custom_only',
        'arr_lists_search_no_tmdb', 'arr_lists_kind_movie', 'arr_lists_kind_series'
    ]);

    /** @param {string} key Key. @param {Object} [params] Parameters. @returns {string} Words. */
    const tr = (key, params) => lp.render.tr(key, params);

    /**
     * A search.
     * @param {{ticket: Object, root: HTMLElement, source: 'je'|'seerr'|'none', read: function(string, {signal: AbortSignal}): Promise<{status: number, body: *}>,
     *   lang?: string, isAdmin?: boolean, arrLookup?: function(string, {signal: AbortSignal}): Promise<Object[]>}} options Options.
     * @returns {{query: function(string): Promise<Object|null>, selected: function(): Object|null, customOnly: function(): boolean, destroy: function(): void}} Search.
     */
    function create({ ticket, root, source, read, lang, isAdmin, arrLookup }) {
        const el = lp.render.el;
        let seq = 0;
        let controller = null;
        let shown = [];
        let chosen = null;
        let customOnly = source === 'none';
        let destroyed = false;

        lp.gate.paint(ticket, () => {
            const box = el('div', 'je-list-search');
            const results = el('div', 'je-list-search-results');
            results.setAttribute('role', 'listbox');
            results.setAttribute('aria-label', tr('arr_lists_search_label'));
            const status = el('div', 'je-list-search-status');
            status.setAttribute('role', 'status');
            box.append(results, status);
            root.appendChild(box);
        }, 'search');

        /** Picks a result. @param {MouseEvent} e Event. */
        const onClick = (e) => {
            const row = e.target?.closest?.('[data-je-candidate]');
            if (!row || !root.contains(row)) return;
            chosen = shown[Number(row.dataset.jeCandidate)] || null;
        };
        root.addEventListener('click', onClick);

        /**
         * A result row.
         * @param {Object} c Candidate.
         * @param {number} index Index.
         * @returns {HTMLElement} Row.
         */
        function rowOf(c, index) {
            const row = el('button', 'je-list-search-result');
            row.type = 'button';
            row.setAttribute('role', 'option');
            row.dataset.jeCandidate = String(index);
            row.appendChild(el('span', 'je-list-search-title', c.title));
            const type = (c.identity?.mediaType || c.custom?.mediaType) === 'tv' ? tr('arr_lists_kind_series') : tr('arr_lists_kind_movie');
            const meta = [c.year ? String(c.year) : '', type, c.inert ? tr('arr_lists_search_no_tmdb') : ''].filter(Boolean).join(' · ');
            row.appendChild(el('span', 'je-list-search-meta', meta));
            return row;
        }

        /**
         * Draws an outcome.
         * @param {Object} outcome Search outcome.
         * @param {Object[]} items Candidates.
         */
        function draw(outcome, items) {
            lp.gate.paint(ticket, () => {
                const results = root.querySelector('.je-list-search-results');
                const status = root.querySelector('.je-list-search-status');
                if (!results || !status) return;
                results.replaceChildren(...items.map(rowOf));
                status.textContent = outcome.state === 'custom_only' ? tr('arr_lists_search_custom_only')
                    : outcome.state === 'unavailable' && !items.length ? tr('arr_lists_search_failed')
                        : !items.length ? tr('arr_lists_search_empty') : '';
            }, 'search');
        }

        return {
            /**
             * Searches; only the newest query is drawn.
             * @param {string} text Query.
             * @returns {Promise<Object|null>} The outcome (null when a newer query took over).
             */
            async query(text) {
                if (destroyed) return null;
                controller?.abort();
                const mine = ++seq;
                const local = typeof AbortController === 'function' ? new AbortController() : null;
                controller = local;
                const signal = local?.signal;
                const path = lp.metadata.searchPath(source, text, lang);
                let outcome;
                if (source === 'none') outcome = { state: 'custom_only', reason: 'no_search' };
                else if (!path) outcome = { state: 'results', items: [] };
                else {
                    let answer = null;
                    try {
                        answer = await read(path, { signal });
                    } catch {
                        answer = null;
                    }
                    if (mine !== seq || destroyed) return null;
                    outcome = lp.metadata.searchOutcome(source, answer);
                }
                let items = outcome.state === 'results' ? outcome.items : [];
                if (isAdmin === true && typeof arrLookup === 'function' && String(text || '').trim()) {
                    let found = [];
                    try {
                        found = await arrLookup(String(text).trim(), { signal });
                    } catch {
                        found = [];
                    }
                    if (mine !== seq || destroyed) return null;
                    items = items.concat((Array.isArray(found) ? found : []).map(lp.metadata.fromArr).filter(Boolean));
                }
                if (controller === local) controller = null;
                customOnly = outcome.state === 'custom_only';
                shown = items;
                chosen = null;
                draw(outcome, items);
                return outcome;
            },
            /** @returns {Object|null} The chosen candidate. */
            selected: () => chosen,
            /** @returns {boolean} Only custom entries can be added (with the reason shown). */
            customOnly: () => customOnly,
            /** Stops reads and takes the search away. */
            destroy() {
                destroyed = true;
                controller?.abort();
                root.removeEventListener('click', onClick);
                lp.gate.erase(() => root.querySelectorAll('.je-list-search').forEach(n => n.remove()));
            }
        };
    }

    lp.search = Object.freeze({ KEYS, create });
})(window.JellyfinEnhanced);
