/**
 * @file Requests & downloads, phase 4c3b: the title search of list authoring. A presenter: it draws into a root its
 * caller owns, every write and every awaited read through its own effects on the caller's ticket (lp.surface: checked
 * again when they run), every word through the ticket's guarded words (years follow its date policy, as on the list
 * pages), and reads only through the reader it is given (b2 wires the household's existing route: acquire/search or the
 * Seerr proxy, lp.metadata.searchPath). Nothing runs on load; nothing is cached.
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

    /**
     * A search.
     * @param {{ticket: Object, root: HTMLElement, source: 'je'|'seerr'|'none', read: function(string, {signal: AbortSignal}): Promise<{status: number, body: *}>,
     *   lang?: string, isAdmin?: boolean, arrLookup?: function(string, {signal: AbortSignal}): Promise<Object[]>}} options Options.
     * @returns {{query: function(string): Promise<Object|null>, selected: function(): Object|null, customOnly: function(): boolean, destroy: function(): void}} Search.
     */
    function create({ ticket, root, source, read, lang, isAdmin, arrLookup }) {
        const put = lp.surface.put;
        const fx = lp.surface.effects({ ticket });
        const w = lp.surface.words(ticket);
        let controller = null;
        let shown = [];
        let chosen = null;
        let customOnly = source === 'none';

        fx.paint(null, () => {
            const box = put.el('div', 'je-list-search');
            const results = put.el('div', 'je-list-search-results');
            results.setAttribute('role', 'listbox');
            put.attr(results, 'aria-label', w.key('arr_lists_search_label'));
            const status = put.el('div', 'je-list-search-status');
            status.setAttribute('role', 'status');
            box.append(results, status);
            root.appendChild(box);
        }, 'search');

        /** Picks a result. @param {MouseEvent} e Event. */
        fx.on(root, 'click', (e) => {
            const row = e.target?.closest?.('[data-je-candidate]');
            if (!row || !root.contains(row)) return;
            chosen = shown[Number(row.dataset.jeCandidate)] || null;
        });

        /**
         * A result row: the title's name, then its year as the ticket's date policy allows, its kind and whether it can
         * only fill a custom entry.
         * @param {Object} c Candidate.
         * @param {number} index Index.
         * @returns {HTMLElement} Row.
         */
        function rowOf(c, index) {
            const row = put.el('button', 'je-list-search-result');
            row.type = 'button';
            row.setAttribute('role', 'option');
            row.dataset.jeCandidate = String(index);
            row.appendChild(put.el('span', 'je-list-search-title', w.name(c.title)));
            const mediaType = (c.identity?.mediaType || c.custom?.mediaType) === 'tv' ? 'tv' : 'movie';
            const entry = { kind: mediaType === 'tv' ? 'series' : 'movie', mediaType, tmdbId: c.identity?.tmdbId ?? null };
            const kind = w.key(mediaType === 'tv' ? 'arr_lists_kind_series' : 'arr_lists_kind_movie');
            const meta = w.join([w.year(entry, c), kind, c.inert ? w.key('arr_lists_search_no_tmdb') : w.none], ' · ');
            row.appendChild(put.el('span', 'je-list-search-meta', meta));
            return row;
        }

        /**
         * Draws an outcome, if its query is still the newest when the paint runs.
         * @param {function(): boolean} check The query's intent.
         * @param {Object} outcome Search outcome.
         * @param {Object[]} items Candidates.
         */
        function draw(check, outcome, items) {
            fx.paint(check, () => {
                const results = root.querySelector('.je-list-search-results');
                const status = root.querySelector('.je-list-search-status');
                if (!results || !status) return;
                results.replaceChildren(...items.map(rowOf));
                put.text(status, outcome.state === 'custom_only' ? w.key('arr_lists_search_custom_only')
                    : outcome.state === 'unavailable' && !items.length ? w.key('arr_lists_search_failed')
                        : !items.length ? w.key('arr_lists_search_empty') : w.none);
            }, 'search');
        }

        return {
            /**
             * Searches; only the newest query is drawn (an older read is aborted and its answer dropped when it comes).
             * @param {string} text Query.
             * @returns {Promise<Object|null>} The outcome (null when a newer query took over, or the search ended).
             */
            query(text) {
                controller?.abort();
                const check = fx.intent('query');
                const local = typeof AbortController === 'function' ? new AbortController() : null;
                controller = local;
                const signal = local?.signal;
                return fx.task(check, async (step) => {
                    const path = lp.metadata.searchPath(source, text, lang);
                    let outcome;
                    if (source === 'none') outcome = { state: 'custom_only', reason: 'no_search' };
                    else if (!path) outcome = { state: 'results', items: [] };
                    else {
                        const answer = await step(() => read(path, { signal }));
                        outcome = lp.metadata.searchOutcome(source, answer.ok ? answer.value : null);
                    }
                    let items = outcome.state === 'results' ? outcome.items : [];
                    if (isAdmin === true && typeof arrLookup === 'function' && String(text || '').trim()) {
                        const found = await step(() => arrLookup(String(text).trim(), { signal }));
                        const list = found.ok && Array.isArray(found.value) ? found.value : [];
                        items = items.concat(list.map(lp.metadata.fromArr).filter(Boolean));
                    }
                    if (controller === local) controller = null;
                    customOnly = outcome.state === 'custom_only';
                    shown = items;
                    chosen = null;
                    draw(check, outcome, items);
                    return outcome;
                });
            },
            /** @returns {Object|null} The chosen candidate. */
            selected: () => chosen,
            /** @returns {boolean} Only custom entries can be added (with the reason shown). */
            customOnly: () => customOnly,
            /** Stops reads and takes the search away, for good. */
            destroy() {
                fx.destroy();
                controller?.abort();
                lp.gate.erase(() => root.querySelectorAll('.je-list-search').forEach(n => n.remove()));
            }
        };
    }

    lp.search = Object.freeze({ KEYS, create });
})(window.JellyfinEnhanced);
