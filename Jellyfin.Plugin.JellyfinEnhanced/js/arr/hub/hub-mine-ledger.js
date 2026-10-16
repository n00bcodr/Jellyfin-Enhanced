/**
 * @file Requests & downloads, phase 3: the request ledger in My requests. Reads the caller's own
 * requests (GET /JellyfinEnhanced/acquire/requests/mine) under an intent token and merges them with
 * the page's existing entries, one row per title (a title the page already lists keeps its row and
 * status; the ledger adds what is missing): waiting for an OK, on the way, said no. Rows of requests
 * not sent yet get **Cancel** (JE.arrAsk.cancel), with the honest outcome in a toast. Cancelled and
 * finished ones are left to the existing groups; one that arrived and was removed since ("Was here,
 * since removed") gets **Get it again** for people who may ask (or says "Paused: storage full").
 * Re-reads when the caller's request list changes on the feed, or after an ask or cancel on this page.
 */
(function (JE) {
    'use strict';

    const H = (JE.internals = JE.internals || {}).arrHub = JE.internals.arrHub || {};
    const X = H.ext;
    const ROUTE = '/acquire/requests/mine';
    const ORDER = { needsOk: 0, onTheWay: 1, declined: 2 };
    const logPrefix = '🪼 Jellyfin Enhanced: My requests:';

    const tokens = X.intent('mine');
    const state = {
        items: null,
        epoch: null,
        loading: null,
        stale: true,
        unfollow: null,
        busy: new Set(),
        listening: false,
        scheduled: false,
        visit: null
    };

    /**
     * Forgets everything read for another user.
     * @returns {void}
     */
    function resetForUser() {
        if (state.epoch === X.epoch()) return;
        state.epoch = X.epoch();
        state.items = null;
        state.stale = true;
        state.busy.clear();
        tokens.drop();
        if (state.unfollow) state.unfollow();
        state.unfollow = null;
    }

    /**
     * True when the ledger rows apply (phase 3 request controls on).
     * @returns {boolean} On.
     */
    function on() {
        return JE.arrAsk?.enabled?.() === true;
    }

    /**
     * Reads the caller's ledger requests under a fresh intent token; the page redraws when the
     * answer is still current.
     * @returns {Promise<void>}
     */
    async function load() {
        resetForUser();
        state.stale = false;
        state.visit = H.state?.generation ?? null;
        const token = tokens.next();
        const run = (async () => {
            const answer = await X.call(ROUTE);
            if (!tokens.isCurrent(token)) return;
            if (state.loading === run) state.loading = null;
            if (answer.status === 200 && Array.isArray(answer.body?.items)) {
                state.items = answer.body.items;
            } else {
                // What was shown stays; the next change on the feed (or the next visit) reads again.
                console.warn(`${logPrefix} could not load (${answer.status || 'no answer'})`);
            }
            if (H.state?.visible) H.render?.();
        })();
        state.loading = run;
        return run;
    }

    /**
     * Starts following the caller's request list while the page shows (stops on its own when the
     * page is no longer shown).
     * @returns {void}
     */
    function follow() {
        if (state.unfollow) return;
        const keys = [X.userKey(), 'req:state'].filter(Boolean);
        state.unfollow = X.follow(keys, () => {
            if (!H.state?.visible) {
                state.stale = true;
                if (state.unfollow) state.unfollow();
                state.unfollow = null;
                return;
            }
            load();
        });
        if (!state.listening && JE.arrAsk?.onChange) {
            state.listening = true;
            JE.arrAsk.onChange(() => {
                state.stale = true;
                if (H.state?.visible) load();
            });
        }
    }

    /**
     * The status pill a ledger request shows (the family words of its state).
     * @param {Object} item Ledger request.
     * @returns {Object} Status.
     */
    function statusOf(item) {
        if (item.group === 'needsOk') return { key: item.key, kind: item.kind, stage: 'asked', reason: { code: 'awaiting_approval' }, quiet: false, actions: [] };
        if (item.group === 'declined') return { key: item.key, kind: item.kind, stage: 'notHere', reason: { code: 'declined' }, quiet: false, actions: [] };
        return { key: item.key, kind: item.kind, stage: 'approved', reason: { code: 'approved' }, quiet: false, actions: [] };
    }

    /**
     * My requests with the ledger's requests added: one entry per title key. An entry the page
     * already has keeps its row (and gains Cancel for the ledger's unsent requests); a title only the
     * ledger knows gets a row of its own. Starts a read when there is nothing current.
     * @param {Object} view The page's visible data.
     * @returns {Object} The view with the merged My requests.
     */
    function merge(view) {
        if (!on()) return view;
        resetForUser();
        if (H.state?.visible) follow();
        // Read once per visit to the page, and again after a change.
        if (state.visit !== (H.state?.generation ?? null)) state.stale = true;
        if (state.stale && !state.scheduled && !(state.loading && tokens.isCurrent(tokens.current()))) {
            // One read for the burst of renders that asked (the tab strip and the panel both merge).
            state.scheduled = true;
            Promise.resolve().then(() => {
                state.scheduled = false;
                load();
            });
        }
        if (!Array.isArray(state.items) || !state.items.length) return view;
        const byKey = new Map();
        for (const item of state.items) {
            if (!(item.group in ORDER)) continue;
            if (!byKey.has(item.key)) byKey.set(item.key, []);
            byKey.get(item.key).push(item);
        }
        const mine = [];
        const seen = new Set();
        for (const entry of view.mine || []) {
            const own = byKey.get(entry.key);
            seen.add(entry.key);
            mine.push(own ? { ...entry, ledger: ledgerOf(own) } : entry);
        }
        // A title the page already lists as Ready is that title's row (its requests' parts arrived; the ledger may
        // not have marked them fulfilled yet): no second row with the request's own state.
        for (const entry of view.ready || []) if (entry?.key) seen.add(entry.key);
        for (const [key, own] of byKey) {
            if (seen.has(key)) continue;
            // The most open state of the title's requests leads (waiting before on the way before said no).
            const lead = [...own].sort((a, b) => ORDER[a.group] - ORDER[b.group])[0];
            const seasons = [...new Set(own.flatMap(i => i.seasons || []))].sort((a, b) => a - b);
            mine.push({
                key,
                kind: lead.kind,
                title: lead.title || '',
                year: lead.year,
                poster: lead.poster,
                itemId: lead.itemId,
                is4k: own.every(i => i.variant === '4k'),
                seasons: lead.kind === 'tv' && seasons.length ? seasons : null,
                askedAt: own.map(i => i.createdAt).sort()[0],
                group: lead.group,
                status: statusOf(lead),
                ledger: ledgerOf(own)
            });
        }
        mine.sort((a, b) => (ORDER[a.group] ?? 3) - (ORDER[b.group] ?? 3) || String(b.askedAt || '').localeCompare(String(a.askedAt || '')));
        return { ...view, mine };
    }

    /**
     * The ledger part of a row: the ids that can still be cancelled.
     * @param {Object[]} own The title's ledger requests.
     * @returns {{cancel: string[]}} Ledger part.
     */
    function ledgerOf(own) {
        return { cancel: own.filter(i => i.canCancel && typeof i.id === 'string').map(i => i.id) };
    }

    /**
     * Adds Cancel to a My requests row whose ledger requests haven't been sent yet (and Get it again, or why not, to
     * one removed since).
     * @param {Object} entry Row entry.
     * @param {HTMLElement} buttons The row's button box.
     * @param {HTMLElement} [body] The row's text column (what the row says).
     * @returns {void}
     */
    function rowExtras(entry, buttons, body) {
        againButton(entry, buttons, body);
        const ids = entry?.ledger?.cancel;
        if (!Array.isArray(ids) || !ids.length || !on()) return;
        const busy = ids.some(id => state.busy.has(id));
        const cancel = X.button('je-hub-btn je-hub-cancel', X.tr(busy ? 'arr_mine_cancelling' : 'arr_mine_cancel'), 'cancel', `cancel:${entry.key || ''}`);
        cancel.setAttribute('aria-label', X.tr('arr_mine_cancel_label', { title: X.titleText(entry) }));
        X.busy(cancel, busy);
        cancel.addEventListener('click', (e) => {
            e.stopPropagation();
            cancelAll(ids);
        });
        cancel.addEventListener('keydown', e => e.stopPropagation());
        buttons.appendChild(cancel);
    }

    /**
     * Adds Get it again to a My requests row whose request arrived and was removed since (from Jellyfin and the
     * arrs): the same part asked for again, for people who may ask for its kind (Kids: "Ask {contact} again"). While
     * asking for new titles of its kind is paused for storage (it was removed, so asking again adds it anew; the
     * household pause is the standard edition's) the row says so in plain words instead, under what it says.
     * @param {Object} entry Row entry.
     * @param {HTMLElement} buttons The row's button box.
     * @param {HTMLElement} [body] The row's text column.
     * @returns {void}
     */
    function againButton(entry, buttons, body) {
        if (!on() || !entry?.key || (entry.group !== 'removed' && entry.status?.reason?.code !== 'removed')) return;
        const caps = X.capabilities();
        const kind = entry.kind === 'movie' ? 'movie' : 'series';
        if (!caps || !JE.arrAsk.canAsk(caps, kind) || !againInputs(entry).length) return;
        const block = entry.is4k ? null : JE.arrAsk.paused?.(caps, kind);
        const words = block ? JE.arrAsk.blockWords(block, caps) : null;
        if (words) {
            // Visible text, not a tooltip: touch, TV and screen readers get the sentence (administrators: where and how much is free).
            (body || buttons).appendChild(JE.arrAsk.pausedNote(words));
            return;
        }
        const id = `again:${entry.key}`;
        const busy = state.busy.has(id);
        const label = busy ? X.tr('arr_ask_asking') : caps.asksFirst ? X.tr('arr_mine_again_ask', { contact: JE.arrAsk.contact(caps) }) : X.tr('arr_mine_again');
        const again = X.button('je-hub-btn je-hub-again', label, 'replay', id);
        again.setAttribute('aria-label', X.tr('arr_mine_again_label', { title: X.titleText(entry) }));
        X.busy(again, busy);
        again.addEventListener('click', (e) => {
            e.stopPropagation();
            askAgain(entry);
        });
        again.addEventListener('keydown', e => e.stopPropagation());
        buttons.appendChild(again);
    }

    /**
     * The asks that ask for a removed request's part again: the movie (its edition), the whole seasons and the
     * single episodes the row names.
     * @param {Object} entry Row entry ({key, kind, is4k, seasons, episodes}).
     * @returns {Object[]} Mutation inputs.
     */
    function againInputs(entry) {
        const variant = entry.is4k ? '4k' : 'standard';
        if (entry.kind === 'movie') return [JE.arrAsk.movieInput(entry.key, variant)];
        const inputs = [];
        if (Array.isArray(entry.seasons) && entry.seasons.length) inputs.push(JE.arrAsk.seasonsInput(entry.key, entry.seasons, variant));
        const episodes = Array.isArray(entry.episodes) ? entry.episodes.filter(e => Number.isInteger(e?.season) && Number.isInteger(e?.episode)) : [];
        if (episodes.length) inputs.push(JE.arrAsk.episodesInput(entry.key, episodes, variant));
        return inputs;
    }

    /**
     * Asks for a removed request's part again and says how it went.
     * @param {Object} entry Row entry.
     * @returns {Promise<void>}
     */
    async function askAgain(entry) {
        const id = `again:${entry.key}`;
        const inputs = againInputs(entry);
        if (state.busy.has(id) || !inputs.length) return;
        state.busy.add(id);
        if (H.state?.visible) H.render?.();
        const asked = X.epoch();
        let last = null;
        try {
            for (const input of inputs) {
                last = await JE.arrAsk.ask(input);
                if (last.stale || !(last.ok || last.state === 'unknown')) break;
            }
        } finally {
            state.busy.delete(id);
        }
        if (asked !== X.epoch() || !last || last.stale) return;
        const caps = await JE.arrAsk.me();
        const allowance = last.state === 'quota' ? await JE.arrAsk.quota(entry.kind === 'movie' ? 'movie' : 'tv') : null;
        JE.arrAsk.toast(JE.arrAsk.describe(last, caps, allowance).text);
        state.stale = true;
        if (H.state?.visible) {
            load();
            H.load?.();
        }
    }

    /**
     * Cancels the caller's unsent requests of one title and says how it went.
     * @param {string[]} ids Request ids.
     * @returns {Promise<void>}
     */
    async function cancelAll(ids) {
        if (ids.some(id => state.busy.has(id))) return;
        ids.forEach(id => state.busy.add(id));
        if (H.state?.visible) H.render?.();
        const asked = X.epoch();
        let last = null;
        for (const id of ids) {
            last = await JE.arrAsk.cancel(id);
            if (!last.ok) break;
        }
        ids.forEach(id => state.busy.delete(id));
        if (asked !== X.epoch()) return;
        if (last) JE.arrAsk.toast(JE.arrAsk.describe(last, await JE.arrAsk.me()).text);
        state.stale = true;
        if (H.state?.visible) {
            load();
            H.load?.();
        }
    }

    JE.session?.onUserChange?.('arr-mine-ledger', () => resetForUser());

    H.mineLedger = { merge, load, state, againInputs };
    H.rowExtras = rowExtras;
})(window.JellyfinEnhanced);
