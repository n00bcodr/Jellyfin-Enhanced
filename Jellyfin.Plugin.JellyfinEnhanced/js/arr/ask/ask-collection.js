/**
 * @file Requests & downloads, phase 3: collection pages. "You have 4 of 6. Get the 2 missing" with
 * a cost preview ("Uses 2 of your 5 this week; 1 need Dad's OK"), the missing movies listed (not out
 * yet ones say so and are not asked for), and **Get the N missing**, which asks for each released
 * missing movie in turn (at most 20, each its own retry-safe ask) and then says honestly what
 * happened ("Asked for 2 · 1 waits for Dad's OK · 1 couldn't be asked"). A movie the server marks as paused
 * (`blocked`: the drive it would land on, its own folder when Radarr has it, else the default root, is nearly full)
 * is left out of the batch, says "Paused: storage full" in the list, and the block says why (where and how much is
 * free for administrators); with every movie paused that line takes the button's place. One
 * GET .../acquire/requests/collection/{itemId} per collection page view; an answer is shown only
 * while its page, user and request are still the current ones. Each missing movie's title opens its page (its
 * native page when offered, else the more-info window). When the server couldn't check storage yet
 * (`pausesPending`, e.g. right after a restart or while the arr's disk facts can't be read) the button says "Checking
 * storage…" and the block is read again after 2 s and 6 s; still unknown then, nothing is asked for: the note says so
 * and the button becomes "Check storage again" (an ask sent then would not be checked either). Phase 4 (`ArrCollectionGapsPhase4`): movies the collection's list already shows are left out by the server
 * (`covered`, said in a note), and the older Seerr "Missing from" row stays away from a page this block answers.
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
    /** Delays (ms after the first answer) of the reads again while storage isn't checked yet. */
    const RECHECKS = [2000, 6000];
    let recheckTimer = 0;
    /** @type {{itemId: string, epoch: number}|null} the collection this page has a gaps answer for */
    let answered = null;
    /** @type {{itemId: string, epoch: number, promise: Promise<void>}|null} the gaps read in flight */
    let inflight = null;

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
        answered = null;
        stopRecheck();
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
        stopRecheck();
        if (answered?.itemId !== itemId) answered = null;
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
     * Reads the gaps and capabilities, then renders (only while the intent is current); the read is known as in
     * flight meanwhile ({@link settled}).
     * @param {HTMLElement} page Page.
     * @param {Object} token Intent token.
     * @param {number} [attempt] Reads again so far while storage isn't checked yet (0: the first read).
     * @returns {Promise<void>}
     */
    function load(page, token, attempt = 0) {
        const promise = loadOnce(page, token, attempt);
        const mine = { itemId: token.itemId, epoch: token.epoch, promise };
        inflight = mine;
        const done = () => { if (inflight === mine) inflight = null; };
        promise.then(done, done);
        return promise;
    }

    /**
     * One read of the gaps and capabilities, then the render.
     * @param {HTMLElement} page Page.
     * @param {Object} token Intent token.
     * @param {number} attempt Reads again so far.
     * @returns {Promise<void>}
     */
    async function loadOnce(page, token, attempt) {
        const lang = (navigator.language || 'en').split('-')[0];
        let gaps = null;
        try {
            const answer = await JE.arrAsk.call(`/acquire/requests/collection/${encodeURIComponent(token.itemId)}?language=${encodeURIComponent(lang)}`);
            gaps = answer.status === 200 && answer.body?.collection ? answer.body.collection : null;
        } catch {
            gaps = null;
        }
        if (!isCurrent(token)) return;
        if (gaps && phase4()) {
            // This block answers the page: the older Seerr row would offer the same movies again.
            answered = { itemId: token.itemId, epoch: token.epoch };
            removeSeerrRow(page);
        }
        const caps = await JE.arrAsk.me();
        const allowance = JE.arrAsk.canAsk(caps, 'movie') ? await JE.arrAsk.quota('movie') : null;
        if (!isCurrent(token)) return;
        render(page, token, gaps, caps, allowance, attempt);
        // Only a person who may ask has anything waiting on the storage check.
        if (gaps?.pausesPending === true && attempt < RECHECKS.length && JE.arrAsk.canAsk(caps, 'movie')) scheduleRecheck(page, token, attempt);
    }

    /**
     * True when the phase 4 collection-gaps additions are on (the server's effective switch).
     * @returns {boolean} On.
     */
    function phase4() {
        return JE.pluginConfig?.ArrCollectionGapsPhase4 === true;
    }

    /**
     * Removes the older Seerr "Missing from" row from the page (it raced in before this block's answer).
     * @param {ParentNode} page Page.
     * @returns {void}
     */
    function removeSeerrRow(page) {
        page.querySelectorAll('.jellyseerr-collection-discovery-section').forEach(n => n.remove());
    }

    /**
     * Phase 4: whether this block answers the collection page of `itemId` for the current person (the older Seerr row
     * then stays away).
     * @param {string} itemId Collection item id.
     * @returns {boolean} Answered.
     */
    function covers(itemId) {
        return phase4() && !!itemId && answered?.itemId === itemId && answered.epoch === epoch();
    }

    /**
     * Phase 4: waits for a gaps read of `itemId` still in flight (at most `maxMs`), then says whether this block answers
     * that page ({@link covers}). Resolves at once when none is in flight.
     * @param {string} itemId Collection item id.
     * @param {number} [maxMs] Longest wait.
     * @returns {Promise<boolean>} Answered.
     */
    async function settled(itemId, maxMs = 8000) {
        if (!phase4()) return false;
        const pending = inflight?.itemId === itemId && inflight.epoch === epoch() ? inflight.promise : null;
        if (pending) {
            let timer = 0;
            await Promise.race([pending.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, maxMs); })]);
            clearTimeout(timer);
        }
        return covers(itemId);
    }

    /**
     * Reads the block again shortly while the server couldn't check storage yet (bounded by {@link RECHECKS}).
     * @param {HTMLElement} page Page.
     * @param {Object} token Intent token of the answer shown.
     * @param {number} attempt Reads again so far.
     * @returns {void}
     */
    function scheduleRecheck(page, token, attempt) {
        stopRecheck();
        const wait = RECHECKS[attempt] - (attempt > 0 ? RECHECKS[attempt - 1] : 0);
        recheckTimer = setTimeout(() => {
            recheckTimer = 0;
            // Gone, another person, or a batch running (it reads the block again itself).
            if (!isCurrent(token) || running) return;
            const again = { ...token, seq: ++seq };
            intent = again;
            load(page, again, attempt + 1);
        }, wait);
    }

    /**
     * Cancels a pending read again.
     * @returns {void}
     */
    function stopRecheck() {
        if (recheckTimer) clearTimeout(recheckTimer);
        recheckTimer = 0;
    }

    /**
     * The movies "Get the N missing" asks for: released, not asked for by anyone yet, not paused, and ones the person
     * can ask for at all (`askable: false` is the title check's "can't request" with nothing to explain).
     * @param {Object} gaps Collection gaps.
     * @returns {Array<Object>} Parts.
     */
    function gettable(gaps) {
        return (gaps?.missing || []).filter(p => p.released && !p.request && p.askable !== false && !blockOf(p)).slice(0, MAX_BATCH);
    }

    /**
     * Why a missing movie can't be asked for right now (the server's per-movie answer), or null.
     * @param {Object} part Part.
     * @returns {Object|null} Block ({reason, ...}).
     */
    function blockOf(part) {
        return part?.released && !part.request && typeof part.blocked?.reason === 'string' ? part.blocked : null;
    }

    /**
     * The paused lines of a collection: one per different explanation of its paused movies (family members read
     * one sentence; administrators one line per drive), in list order.
     * @param {Object} gaps Collection gaps.
     * @param {Object} caps Capabilities.
     * @returns {Array<Object>} Words ({@link JE.arrAsk.blockWords}).
     */
    function pausedWords(gaps, caps) {
        const lines = new Map();
        for (const part of gaps?.missing || []) {
            const words = blockOf(part) ? JE.arrAsk.blockWords(part.blocked, caps) : null;
            if (words) lines.set(`${words.chip}|${words.detail || words.text}`, words);
        }
        return [...lines.values()];
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
     * @param {number} [attempt] Reads again so far while storage isn't checked yet.
     * @returns {void}
     */
    function render(page, token, gaps, caps, allowance, attempt = 0) {
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
        const mayAsk = JE.arrAsk.canAsk(caps, 'movie');
        // Movies that can't be asked for now (their drive is nearly full) are said, title by title, not asked for.
        const paused = mayAsk && JE.arrAsk.blockWords ? pausedWords(gaps, caps) : [];
        // Storage not checked yet: nothing is offered as gettable until it is. While the reads again run the button
        // waits; after them it reads the block again on demand (an ask sent now would not be checked either).
        const pending = mayAsk && gaps.pausesPending === true && parts.length > 0;
        const checking = pending && attempt < RECHECKS.length;
        if (mayAsk && parts.length) {
            const n = parts.length;
            const label = checking ? tr('arr_collection_checking_storage') : pending ? tr('arr_collection_check_again') : caps.asksFirst
                ? (n === 1 ? tr('arr_collection_ask_one', { contact }) : tr('arr_collection_ask', { contact, n }))
                : (n === 1 ? tr('arr_collection_get_one') : tr('arr_collection_get', { n }));
            const b = S.el('button', 'je-ask-action je-ask-coll-get');
            b.type = 'button';
            b.appendChild(S.icon(checking ? 'hourglass_empty' : pending ? 'refresh' : caps.asksFirst ? 'front_hand' : 'download', 'je-ask-action-icon'));
            b.appendChild(S.el('span', 'je-ask-action-text', label));
            if (checking) {
                b.disabled = true;
                b.setAttribute('aria-busy', 'true');
            }
            b.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (b.disabled || running) return;
                if (pending) {
                    // Check again: the same bounded reads again, from the start.
                    stopRecheck();
                    const again = { ...token, seq: ++seq };
                    intent = again;
                    load(page, again, 0);
                    return;
                }
                getMissing(page, token, parts, caps, b);
            });
            head.appendChild(b);
            const cost = pending ? '' : costPreview(n, caps, allowance);
            if (cost) head.appendChild(S.el('span', 'je-ask-coll-cost', cost));
            if (pending && !checking) head.appendChild(S.el('span', 'je-ask-coll-cost je-ask-coll-unchecked', tr('arr_collection_storage_unchecked')));
        }
        const covered = phase4() && Number.isInteger(gaps.covered) && gaps.covered > 0 ? gaps.covered : 0;
        if (covered) {
            head.appendChild(S.el('span', 'je-ask-coll-cost je-ask-coll-covered',
                covered === 1 ? tr('arr_collection_covered_one') : tr('arr_collection_covered', { n: covered })));
        }
        block.appendChild(head);
        for (const words of paused) block.appendChild(JE.arrAsk.pausedNote(words));

        const list = S.el('ul', 'je-ask-coll-list');
        for (const part of gaps.missing) {
            const li = S.el('li', 'je-ask-coll-part');
            li.appendChild(titleOf(part));
            const words = mayAsk && blockOf(part) ? JE.arrAsk.blockWords(part.blocked, caps) : null;
            const chip = words ? { text: words.chip, tone: 'attention' } : partChip(part);
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
     * A missing movie's title: a link to its page (its native page when the server offers those, else the more-info
     * window), or plain text when neither is loaded.
     * @param {Object} part Part.
     * @returns {HTMLElement} Element.
     */
    function titleOf(part) {
        const S = JE.arrStatus;
        const text = part.year ? `${part.title} (${part.year})` : part.title;
        const tmdb = Number(/^movie:tmdb:(\d+)$/.exec(part.key || '')?.[1] || 0);
        const canOpen = tmdb > 0 && (typeof JE.titleDetails?.show === 'function' || typeof JE.jellyseerrMoreInfo?.open === 'function');
        if (!canOpen) return S.el('bdi', 'je-ask-coll-title', text);
        const a = S.el('a', 'je-ask-coll-title je-ask-coll-link button-link');
        a.href = '#';
        a.appendChild(S.el('bdi', null, text));
        a.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const owner = JE.ownerOf?.(e);
            if (typeof JE.titleDetails?.show === 'function') JE.titleDetails.show(tmdb, 'movie', undefined, owner);
            else JE.jellyseerrMoreInfo.open(tmdb, 'movie', undefined, owner);
        });
        return a;
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
     * The honest summary of a batch: "Asked for 2 · 1 waits for Dad's OK · 1 paused: storage full · 1 couldn't be
     * asked".
     * @param {Array<Object>} results Results of JE.arrAsk.ask.
     * @param {Object} caps Capabilities.
     * @returns {string} Text.
     */
    function summarize(results, caps) {
        const contact = JE.arrAsk.contact(caps);
        let asked = 0;
        let waiting = 0;
        let nothing = 0;
        let paused = 0;
        let ruled = 0;
        let failed = 0;
        for (const r of results) {
            if (r.state === 'waiting') waiting++;
            else if (r.state === 'asked' || r.state === 'merged' || r.state === 'unknown') asked++;
            else if (r.state === 'nothing') nothing++;
            // Its drive filled up since the page was drawn: said as such, not as a failure.
            else if (r.state === 'blocked' && r.reason === 'low_disk') paused++;
            // Phase 4b: refused by the household rules, said as such.
            else if (r.state === 'ruled') ruled++;
            else failed++;
        }
        const pieces = [];
        if (asked) pieces.push(tr('arr_collection_summary_asked', { n: asked }));
        if (waiting) pieces.push(waiting === 1 ? tr('arr_collection_summary_waiting_one', { contact }) : tr('arr_collection_summary_waiting', { n: waiting, contact }));
        if (nothing) pieces.push(tr('arr_collection_summary_nothing', { n: nothing }));
        if (paused) pieces.push(tr('arr_collection_summary_paused', { n: paused }));
        if (ruled) pieces.push(tr('arr_rules_collection_refused', { n: ruled }));
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
        answered = null;
        inflight = null;
        stopRecheck();
    });

    JE.internals = JE.internals || {};
    JE.internals.arrAskCollection = { attach, clear, summarize, costPreview, gettable, covers, settled, isCurrent: (t) => isCurrent(t) };
})(window.JellyfinEnhanced);
