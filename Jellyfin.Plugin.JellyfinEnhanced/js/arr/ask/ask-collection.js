/**
 * @file Requests & downloads, phase 3: collection pages. "You have 4 of 6. Get the 2 missing" with
 * a cost preview ("Uses 2 of your 5 this week; 1 need Dad's OK"), the missing movies listed (not out
 * yet ones say so and are not asked for), and **Get the N missing**, which asks for each released
 * missing movie in turn (at most 20, each its own retry-safe ask) and then says honestly what
 * happened ("Asked for 2 · 1 waits for Dad's OK · 1 couldn't be asked"). One
 * GET .../acquire/requests/collection/{itemId} per collection page view; an answer is shown only
 * while its page, user and request are still the current ones.
 */
(function (JE) {
    'use strict';

    const SURFACE = 'collection';
    /** Most movies one "Get the N missing" asks for. */
    const MAX_BATCH = 20;

    let seq = 0;
    /** @type {{itemId: string, epoch: number, seq: number}|null} the intent whose answer may be shown */
    let intent = null;
    let running = false;

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
     * The current session epoch.
     * @returns {number} Epoch.
     */
    function epoch() {
        return JE.session?.getEpoch ? JE.session.getEpoch() : 0;
    }

    /**
     * True while an intent is still the one the page wants (same request, item, user and page).
     * @param {Object} token Intent token.
     * @returns {boolean} Current.
     */
    function isCurrent(token) {
        return !!token && intent === token && token.epoch === epoch() && currentItemId() === token.itemId;
    }

    /**
     * The details-page item id from the URL hash.
     * @returns {string|null} Id.
     */
    function currentItemId() {
        const hash = window.location.hash || '';
        if (!/details/i.test(hash)) return null;
        try {
            return new URLSearchParams(hash.split('?')[1] || '').get('id');
        } catch {
            return null;
        }
    }

    /**
     * Removes the block (and forgets the page's intent).
     * @param {ParentNode} [root] Where.
     * @returns {void}
     */
    function clear(root) {
        intent = null;
        (root || document).querySelectorAll(`.je-ask-coll[data-je-ask-surface="${SURFACE}"]`).forEach(n => n.remove());
    }

    /**
     * A collection page (status-details found no title status): when the item is a collection,
     * reads its gaps and shows the block.
     * @param {HTMLElement} page Details page.
     * @param {string|null} itemId Item id.
     * @returns {Promise<void>}
     */
    async function attach(page, itemId) {
        if (!page || !itemId || !JE.arrAsk?.enabled()) {
            clear(page || undefined);
            return;
        }
        const token = { itemId, epoch: epoch(), seq: ++seq };
        intent = token;
        let item = null;
        try {
            item = typeof JE.helpers?.getItemCached === 'function' ? await JE.helpers.getItemCached(itemId) : null;
        } catch {
            item = null;
        }
        if (!isCurrent(token)) return;
        if (item?.Type !== 'BoxSet') {
            page.querySelectorAll(`.je-ask-coll[data-je-ask-surface="${SURFACE}"]`).forEach(n => n.remove());
            return;
        }
        await load(page, token);
    }

    /**
     * Reads the gaps and capabilities, then renders (only while the intent is current).
     * @param {HTMLElement} page Page.
     * @param {Object} token Intent token.
     * @returns {Promise<void>}
     */
    async function load(page, token) {
        const lang = (navigator.language || 'en').split('-')[0];
        let gaps = null;
        try {
            const answer = await JE.arrAsk.call(`/acquire/requests/collection/${encodeURIComponent(token.itemId)}?language=${encodeURIComponent(lang)}`);
            gaps = answer.status === 200 && answer.body?.collection ? answer.body.collection : null;
        } catch {
            gaps = null;
        }
        if (!isCurrent(token)) return;
        const caps = await JE.arrAsk.me();
        const allowance = caps?.canRequest ? await JE.arrAsk.quota('movie') : null;
        if (!isCurrent(token)) return;
        render(page, token, gaps, caps, allowance);
    }

    /**
     * The movies "Get the N missing" asks for: released, not asked for by anyone yet.
     * @param {Object} gaps Collection gaps.
     * @returns {Array<Object>} Parts.
     */
    function gettable(gaps) {
        return (gaps?.missing || []).filter(p => p.released && !p.request).slice(0, MAX_BATCH);
    }

    /**
     * The cost preview of asking for n movies.
     * @param {number} n Movies.
     * @param {Object} caps Capabilities.
     * @param {Object|null} allowance Quota.
     * @returns {string} Text ('' when nothing useful to say).
     */
    function costPreview(n, caps, allowance) {
        const contact = JE.arrAsk.contact(caps);
        if (!n) return '';
        if (caps.asksFirst) return tr('arr_collection_all_wait', { n, contact });
        const limitedQuota = JE.internals?.arrAskSheet?.limited ? JE.internals.arrAskSheet.limited(allowance) : false;
        if (!limitedQuota) return '';
        const left = allowance.remaining;
        if (caps.backend === 'seerr' && left < n) return left > 0 ? tr('arr_collection_cost', { cost: left, left }) : tr('arr_collection_quota');
        if (left >= n) return tr('arr_collection_cost', { cost: n, left });
        if (left <= 0) return tr('arr_collection_all_wait', { n, contact });
        return tr('arr_collection_cost_wait', { cost: left, left, waiting: n - left, contact });
    }

    /**
     * Draws the block (replacing the previous one).
     * @param {HTMLElement} page Page.
     * @param {Object} token Intent token.
     * @param {Object|null} gaps Collection gaps.
     * @param {Object|null} caps Capabilities.
     * @param {Object|null} allowance Quota.
     * @returns {void}
     */
    function render(page, token, gaps, caps, allowance) {
        const S = JE.arrStatus;
        const old = page.querySelector(`.je-ask-coll[data-je-ask-surface="${SURFACE}"]`);
        if (!gaps || !(gaps.missing || []).length) {
            if (old) old.remove();
            return;
        }
        JE.internals?.arrAskSheetStyles?.ensure?.();
        const contact = JE.arrAsk.contact(caps);
        const block = S.el('section', 'je-ask-coll');
        block.dataset.jeAskSurface = SURFACE;
        block.setAttribute('aria-label', tr('arr_collection_label'));
        if (JE.internals?.arrAskSheetStyles?.isLight?.()) block.classList.add('je-ask-light');
        const head = S.el('div', 'je-ask-coll-head');
        const have = S.el('span', 'je-ask-coll-have');
        have.appendChild(S.icon('video_library'));
        have.appendChild(S.el('span', null, tr('arr_collection_have', { have: gaps.have, total: gaps.total })));
        head.appendChild(have);
        const parts = gettable(gaps);
        if (caps?.canRequest && parts.length) {
            const n = parts.length;
            const label = caps.asksFirst
                ? (n === 1 ? tr('arr_collection_ask_one', { contact }) : tr('arr_collection_ask', { contact, n }))
                : (n === 1 ? tr('arr_collection_get_one') : tr('arr_collection_get', { n }));
            const b = S.el('button', 'je-ask-action je-ask-coll-get');
            b.type = 'button';
            b.appendChild(S.icon(caps.asksFirst ? 'front_hand' : 'download', 'je-ask-action-icon'));
            b.appendChild(S.el('span', 'je-ask-action-text', label));
            b.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                getMissing(page, token, parts, caps, b);
            });
            head.appendChild(b);
            const cost = costPreview(n, caps, allowance);
            if (cost) head.appendChild(S.el('span', 'je-ask-coll-cost', cost));
        }
        block.appendChild(head);

        const list = S.el('ul', 'je-ask-coll-list');
        for (const part of gaps.missing) {
            const li = S.el('li', 'je-ask-coll-part');
            li.appendChild(S.el('bdi', 'je-ask-coll-title', part.year ? `${part.title} (${part.year})` : part.title));
            const chip = partChip(part);
            if (chip) li.appendChild(S.el('span', `je-arr-chip je-arr-tone-${chip.tone}`, chip.text));
            list.appendChild(li);
        }
        block.appendChild(list);
        const summary = S.el('div', 'je-ask-coll-summary');
        summary.setAttribute('role', 'status');
        summary.setAttribute('aria-live', 'polite');
        block.appendChild(summary);

        if (old) {
            const keep = old.querySelector('.je-ask-coll-summary')?.textContent || '';
            summary.textContent = keep;
            old.replaceWith(block);
        } else {
            const anchor = JE.internals?.arrStatusDetails?.anchorOf?.(page) || page.querySelector('.detailPagePrimaryContent');
            if (!anchor) return;
            anchor.insertBefore(block, anchor.firstChild);
        }
    }

    /**
     * The chip of a missing movie: its request state, or "Not out yet".
     * @param {Object} part Part.
     * @returns {{text: string, tone: string}|null} Chip.
     */
    function partChip(part) {
        switch (part.request) {
            case 'waiting': return { text: tr('arr_ask_chip_waiting'), tone: 'asked' };
            case 'asked': return { text: tr('arr_ask_chip_asked'), tone: 'approved' };
            case 'household': return { text: tr('arr_ask_chip_household'), tone: 'approved' };
            case 'declined': return { text: tr('arr_ask_chip_declined'), tone: 'attention' };
            default: return part.released ? null : { text: tr('arr_collection_not_out'), tone: 'notOut' };
        }
    }

    /**
     * The honest summary of a batch: "Asked for 2 · 1 waits for Dad's OK · 1 couldn't be asked".
     * @param {Array<Object>} results Results of JE.arrAsk.ask.
     * @param {Object} caps Capabilities.
     * @returns {string} Text.
     */
    function summarize(results, caps) {
        const contact = JE.arrAsk.contact(caps);
        let asked = 0;
        let waiting = 0;
        let nothing = 0;
        let failed = 0;
        for (const r of results) {
            if (r.state === 'waiting') waiting++;
            else if (r.state === 'asked' || r.state === 'merged' || r.state === 'unknown') asked++;
            else if (r.state === 'nothing') nothing++;
            else failed++;
        }
        const pieces = [];
        if (asked) pieces.push(tr('arr_collection_summary_asked', { n: asked }));
        if (waiting) pieces.push(waiting === 1 ? tr('arr_collection_summary_waiting_one', { contact }) : tr('arr_collection_summary_waiting', { n: waiting, contact }));
        if (nothing) pieces.push(tr('arr_collection_summary_nothing', { n: nothing }));
        if (failed) pieces.push(failed === 1 ? tr('arr_collection_summary_failed_one') : tr('arr_collection_summary_failed', { n: failed }));
        return pieces.join(' · ');
    }

    /**
     * Asks for each released missing movie in turn, then shows and announces the summary and reads
     * the collection again.
     * @param {HTMLElement} page Page.
     * @param {Object} token Intent token of the page shown.
     * @param {Array<Object>} parts Movies to ask for.
     * @param {Object} caps Capabilities.
     * @param {HTMLButtonElement} button The button.
     * @returns {Promise<void>}
     */
    async function getMissing(page, token, parts, caps, button) {
        if (running) return;
        running = true;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        const text = button.querySelector('.je-ask-action-text');
        const results = [];
        try {
            for (const part of parts) {
                if (text) text.textContent = tr('arr_collection_asking', { done: results.length + 1, total: parts.length });
                let result;
                try {
                    result = await JE.arrAsk.ask(JE.arrAsk.movieInput(part.key));
                } catch {
                    result = { ok: false, state: 'failed' };
                }
                if (result.stale) return;
                results.push(result);
            }
        } finally {
            running = false;
        }
        const line = summarize(results, caps);
        JE.arrAsk.toast(line);
        if (!isCurrent(token)) return;
        const summary = page.querySelector(`.je-ask-coll[data-je-ask-surface="${SURFACE}"] .je-ask-coll-summary`);
        if (summary) summary.textContent = line;
        // The server's truth: which movies now wait or are on their way.
        const again = { ...token, seq: ++seq };
        intent = again;
        await load(page, again);
    }

    JE.session?.onUserChange?.('arr-ask-collection', () => {
        intent = null;
        running = false;
    });

    JE.internals = JE.internals || {};
    JE.internals.arrAskCollection = { attach, clear, summarize, costPreview, gettable, isCurrent: (t) => isCurrent(t) };
})(window.JellyfinEnhanced);
